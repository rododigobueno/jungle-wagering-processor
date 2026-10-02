import { LockMode, QueryOrder } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';

import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/ledger/wallet-ledger-entry.js';
import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import { OutboxMessageEntity } from '../../infrastructure/database/entities/outbox-message.entity.js';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../../infrastructure/database/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../../infrastructure/database/entities/wallet.entity.js';
import {
  getNextReferenceAttemptAt,
  MAX_REFERENCE_RESOLUTION_ATTEMPTS,
} from './pending-reference-policy.js';
import { applyWagerReversal } from './wager-reversal-processing.js';
import { runWithWagerConcurrencyRetry } from './wager-concurrency-retry.js';

export { MAX_REFERENCE_RESOLUTION_ATTEMPTS } from './pending-reference-policy.js';

export interface ResolvePendingReferencesResult {
  processed: number;
  rejected: number;
  rescheduled: number;
}

type ResolveOutcome = 'NONE' | 'PROCESSED' | 'REJECTED' | 'RESCHEDULED';

export class ResolvePendingReferencesUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(limit = 10): Promise<ResolvePendingReferencesResult> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Resolve limit must be a positive integer');
    }

    const result: ResolvePendingReferencesResult = {
      processed: 0,
      rejected: 0,
      rescheduled: 0,
    };

    for (let index = 0; index < limit; index++) {
      const outcome = await runWithWagerConcurrencyRetry(this.em, (tx) =>
        this.resolveNextInTransaction(tx),
      );

      if (outcome === 'NONE') break;
      if (outcome === 'PROCESSED') result.processed += 1;
      if (outcome === 'REJECTED') result.rejected += 1;
      if (outcome === 'RESCHEDULED') result.rescheduled += 1;
    }

    return result;
  }

  private async resolveNextInTransaction(
    tx: EntityManager,
  ): Promise<ResolveOutcome> {
    const now = new Date();
    const entity = await tx.findOne(
      WagerTransactionEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [
          { referenceNextAttemptAt: null },
          { referenceNextAttemptAt: { $lte: now } },
        ],
      },
      {
        orderBy: {
          referenceNextAttemptAt: QueryOrder.ASC,
          createdAt: QueryOrder.ASC,
        },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );

    if (!entity) {
      return 'NONE';
    }

    const walletEntity = await tx.findOne(WalletEntity, {
      id: entity.walletId,
    });

    if (!walletEntity) {
      throw new Error('Wallet not found for pending reference');
    }

    const transaction = rehydrateTransaction(entity);
    const wallet = Wallet.rehydrate({
      id: walletEntity.id,
      playerId: walletEntity.playerId,
      currency: walletEntity.currency,
      balance: Money.from({
        amount: walletEntity.balance,
        currency: walletEntity.currency,
      }),
      version: walletEntity.version,
      createdAt: walletEntity.createdAt,
      updatedAt: walletEntity.updatedAt,
    });

    const money = Money.from({
      amount: entity.amount,
      currency: entity.currency,
    });
    const balanceBefore = wallet.balance;

    const ledgerDirection = await applyWagerReversal({
      tx,
      transaction,
      wallet,
      money,
      now,
    });

    if (transaction.status === WagerTransactionStatus.PendingReference) {
      return this.handleMissingReference(tx, entity, transaction, now);
    }

    this.syncTransaction(entity, transaction, wallet);
    entity.referenceNextAttemptAt = null;

    if (
      transaction.status === WagerTransactionStatus.Processed &&
      ledgerDirection !== undefined
    ) {
      this.persistFinancialEffects(
        tx,
        entity,
        walletEntity,
        wallet,
        money,
        balanceBefore,
        ledgerDirection,
        now,
      );
    }

    this.persistTransactionEvent(tx, transaction, now);
    await tx.flush();

    return transaction.status === WagerTransactionStatus.Processed
      ? 'PROCESSED'
      : 'REJECTED';
  }

  private async handleMissingReference(
    tx: EntityManager,
    entity: WagerTransactionEntity,
    transaction: WagerTransaction,
    now: Date,
  ): Promise<ResolveOutcome> {
    entity.referenceRetryAttempts += 1;

    if (entity.referenceRetryAttempts >= MAX_REFERENCE_RESOLUTION_ATTEMPTS) {
      transaction.reject('REFERENCE_NOT_FOUND');
      entity.status = transaction.status;
      entity.failureCode = transaction.failureCode;
      entity.referenceNextAttemptAt = null;
      this.persistTransactionEvent(tx, transaction, now);
      await tx.flush();

      return 'REJECTED';
    }

    entity.referenceNextAttemptAt = getNextReferenceAttemptAt(
      now,
      entity.referenceRetryAttempts,
    );
    await tx.flush();

    return 'RESCHEDULED';
  }

  private syncTransaction(
    entity: WagerTransactionEntity,
    transaction: WagerTransaction,
    wallet: Wallet,
  ): void {
    entity.status = transaction.status;
    entity.failureCode = transaction.failureCode;
    entity.referenceTransactionId = transaction.referenceTransactionId;
    entity.processedAt = transaction.processedAt;
    entity.resultBalanceAmount = wallet.balance.toJSON().amount;
    entity.resultBalanceCurrency = wallet.balance.currency;
  }

  private persistFinancialEffects(
    tx: EntityManager,
    entity: WagerTransactionEntity,
    walletEntity: WalletEntity,
    wallet: Wallet,
    money: Money,
    balanceBefore: Money,
    ledgerDirection: LedgerDirection,
    now: Date,
  ): void {
    const ledger = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: entity.id,
      direction: ledgerDirection,
      money,
      balanceBefore,
      balanceAfter: wallet.balance,
      createdAt: now,
    });

    tx.persist(
      tx.create(WalletLedgerEntryEntity, {
        id: ledger.id,
        walletId: ledger.walletId,
        transactionId: ledger.transactionId,
        direction: ledger.direction,
        amount: ledger.money.toJSON().amount,
        currency: ledger.money.currency,
        balanceBefore: ledger.balanceBefore.toJSON().amount,
        balanceAfter: ledger.balanceAfter.toJSON().amount,
        createdAt: ledger.createdAt,
      }),
    );

    walletEntity.balance = wallet.balance.toJSON().amount;
    walletEntity.updatedAt = wallet.updatedAt;

    tx.persist(
      tx.create(OutboxMessageEntity, {
        id: randomUUID(),
        aggregateId: wallet.id,
        eventType: 'WalletBalanceChanged',
        payload: {
          version: 1,
          walletId: wallet.id,
          balanceBefore: balanceBefore.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
        },
        occurredAt: now,
        attempts: 0,
      }),
    );
  }

  private persistTransactionEvent(
    tx: EntityManager,
    transaction: WagerTransaction,
    now: Date,
  ): void {
    const eventType =
      transaction.status === WagerTransactionStatus.Rejected
        ? 'WagerTransactionRejected'
        : 'WagerTransactionProcessed';

    tx.persist(
      tx.create(OutboxMessageEntity, {
        id: randomUUID(),
        aggregateId: transaction.id,
        eventType,
        payload: {
          version: 1,
          transactionId: transaction.id,
          walletId: transaction.walletId,
          providerId: transaction.providerId,
          kind: transaction.kind,
          status: transaction.status,
          failureCode: transaction.failureCode,
        },
        occurredAt: now,
        attempts: 0,
      }),
    );
  }
}

function rehydrateTransaction(
  entity: WagerTransactionEntity,
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    walletId: entity.walletId,
    playerId: entity.playerId,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind as WagerTransactionKind,
    money: Money.from({ amount: entity.amount, currency: entity.currency }),
    referenceExternalTransactionId:
      entity.referenceExternalTransactionId ?? undefined,
    createdAt: entity.createdAt,
    status: entity.status as WagerTransactionStatus,
    referenceTransactionId: entity.referenceTransactionId ?? undefined,
    failureCode: entity.failureCode ?? undefined,
    processedAt: entity.processedAt ?? undefined,
  });
}
