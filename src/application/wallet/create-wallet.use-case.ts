import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'node:crypto';

import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wagering/wager-transaction.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/ledger/wallet-ledger-entry.js';

import { WalletEntity } from '../../infrastructure/database/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../../infrastructure/database/entities/wallet-ledger-entry.entity.js';
import { OutboxMessageEntity } from '../../infrastructure/database/entities/outbox-message.entity.js';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: {
    amount: string;
    currency: string;
  };
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    const initialBalance = Money.from(input.initialBalance);
    const walletId = randomUUID();

    const wallet = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
    });

    await this.em.transactional(async (em) => {
      const walletEntity = em.create(WalletEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });

      em.persist(walletEntity);

      if (initialBalance.isZero()) {
        return;
      }

      const transactionId = randomUUID();
      const now = new Date();

      const payloadHash = createHash('sha256')
        .update(
          JSON.stringify({
            walletId,
            playerId: input.playerId,
            amount: initialBalance.toJSON(),
          }),
        )
        .digest('hex');

      const opening = WagerTransaction.create({
        id: transactionId,
        providerId: 'internal',
        externalTransactionId: `opening:${walletId}`,
        idempotencyKey: `internal:opening:${walletId}`,
        payloadHash,
        walletId,
        playerId: input.playerId,
        roundId: 'internal',
        gameId: 'internal',
        kind: WagerTransactionKind.Opening,
        money: initialBalance,
        createdAt: now,
      });

      opening.markProcessed(undefined, now);

      const balanceBefore = Money.zero(wallet.currency);

      const ledger = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId,
        transactionId,
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore,
        balanceAfter: wallet.balance,
        createdAt: now,
      });

      const openingEntity = em.create(WagerTransactionEntity, {
        id: opening.id,
        providerId: opening.providerId,
        externalTransactionId: opening.externalTransactionId,
        idempotencyKey: opening.idempotencyKey,
        payloadHash: opening.payloadHash,
        walletId: opening.walletId,
        playerId: opening.playerId,
        roundId: opening.roundId,
        gameId: opening.gameId,
        kind: opening.kind,
        amount: opening.money.toJSON().amount,
        currency: opening.money.currency,
        referenceRetryAttempts: 0,
        status: opening.status,
        createdAt: opening.createdAt,
        processedAt: opening.processedAt,
      });

      const ledgerEntity = em.create(WalletLedgerEntryEntity, {
        id: ledger.id,
        walletId: ledger.walletId,
        transactionId: ledger.transactionId,
        direction: ledger.direction,
        amount: ledger.money.toJSON().amount,
        currency: ledger.money.currency,
        balanceBefore: ledger.balanceBefore.toJSON().amount,
        balanceAfter: ledger.balanceAfter.toJSON().amount,
        createdAt: ledger.createdAt,
      });

      const transactionProcessedEvent = em.create(OutboxMessageEntity, {
        id: randomUUID(),
        aggregateId: transactionId,
        eventType: 'WagerTransactionProcessed',
        payload: {
          version: 1,
          transactionId,
          walletId,
          kind: WagerTransactionKind.Opening,
          amount: initialBalance.toJSON(),
        },
        occurredAt: now,
        attempts: 0,
      });

      const balanceChangedEvent = em.create(OutboxMessageEntity, {
        id: randomUUID(),
        aggregateId: walletId,
        eventType: 'WalletBalanceChanged',
        payload: {
          version: 1,
          walletId,
          balanceBefore: balanceBefore.toJSON(),
          balanceAfter: wallet.balance.toJSON(),
        },
        occurredAt: now,
        attempts: 0,
      });

      em.persist(openingEntity);
      em.persist(ledgerEntity);
      em.persist(transactionProcessedEvent);
      em.persist(balanceChangedEvent);

      await em.flush();
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}