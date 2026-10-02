import { Injectable } from '@nestjs/common';
import {
  OptimisticLockError,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';

import { createPayloadHash } from '../shared/canonical-payload.js';
import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/ledger/wallet-ledger-entry.js';

import { WalletEntity } from '../../infrastructure/database/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../../infrastructure/database/entities/wallet-ledger-entry.entity.js';
import { OutboxMessageEntity } from '../../infrastructure/database/entities/outbox-message.entity.js';

const MAX_CONCURRENCY_RETRIES = 5;

const RETRYABLE_TRANSACTION_UNIQUE_CONSTRAINTS = new Set([
  'wager_transaction_idempotency_key_unique',
  'wager_transaction_provider_external_unique',
]);

export interface ProcessWagerTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: {
    amount: string;
    currency: string;
  };
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: {
    amount: string;
    currency: string;
  };
  idempotentReplay: boolean;
  failureCode?: string;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key already used with a different payload');
  }
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionOutput> {
    if (input.kind === WagerTransactionKind.Opening) {
      throw new Error('OPENING is internal only');
    }

    const money = Money.from(input.money);

    const payloadHash = createPayloadHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    for (let attempt = 1; attempt <= MAX_CONCURRENCY_RETRIES; attempt++) {
      const em = this.em.fork();

      try {
        return await em.transactional(async (tx) => {
          const existing = await tx.findOne(WagerTransactionEntity, {
            idempotencyKey: input.idempotencyKey,
          });

          if (existing) {
            if (existing.payloadHash !== payloadHash) {
              throw new IdempotencyConflictError();
            }

            if (
              existing.resultBalanceAmount == null ||
              existing.resultBalanceCurrency == null
            ) {
              throw new Error(
                'Stored transaction does not have a result balance',
              );
            }

            return {
              transactionId: existing.id,
              status: existing.status as WagerTransactionStatus,
              balance: {
                amount: existing.resultBalanceAmount,
                currency: existing.resultBalanceCurrency,
              },
              idempotentReplay: true,
              failureCode: existing.failureCode,
            };
          }

          const walletEntity = await tx.findOne(WalletEntity, {
            id: input.walletId,
          });

          if (!walletEntity) {
            throw new Error('Wallet not found');
          }

          if (walletEntity.playerId !== input.playerId) {
            throw new Error('Wallet does not belong to player');
          }

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

          const transactionId = randomUUID();
          const now = new Date();

          const transaction = WagerTransaction.create({
            id: transactionId,
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
            idempotencyKey: input.idempotencyKey,
            payloadHash,
            walletId: input.walletId,
            playerId: input.playerId,
            roundId: input.roundId,
            gameId: input.gameId,
            kind: input.kind,
            money,
            referenceExternalTransactionId:
              input.referenceExternalTransactionId,
            createdAt: now,
          });

          const balanceBefore = wallet.balance;

          let ledgerDirection: LedgerDirection | undefined;

          if (input.kind === WagerTransactionKind.Bet) {
            try {
              wallet.debit(money);
              ledgerDirection = LedgerDirection.Debit;
            } catch (error) {
              if (
                error instanceof Error &&
                error.message === 'Insufficient funds'
              ) {
                transaction.reject('INSUFFICIENT_FUNDS');
              } else {
                throw error;
              }
            }
          } else if (input.kind === WagerTransactionKind.Win) {
            wallet.credit(money);
            ledgerDirection = LedgerDirection.Credit;
          } else if (input.kind === WagerTransactionKind.Loss) {
            // LOSS é auditável, mas não movimenta saldo.
          } else {
            throw new Error(
              `${input.kind} is not implemented in this processing stage`,
            );
          }

          if (!transaction.isTerminal()) {
            transaction.markProcessed(undefined, now);
          }

          if (
            transaction.status === WagerTransactionStatus.Processed &&
            ledgerDirection !== undefined
          ) {
            const ledger = WalletLedgerEntry.create({
              id: randomUUID(),
              walletId: wallet.id,
              transactionId,
              direction: ledgerDirection,
              money,
              balanceBefore,
              balanceAfter: wallet.balance,
              createdAt: now,
            });

            const ledgerEntity = tx.create(WalletLedgerEntryEntity, {
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

            tx.persist(ledgerEntity);
          }

          if (!wallet.balance.equals(balanceBefore)) {
            walletEntity.balance = wallet.balance.toJSON().amount;
            walletEntity.updatedAt = wallet.updatedAt;

            const balanceChangedEvent = tx.create(OutboxMessageEntity, {
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
            });

            tx.persist(balanceChangedEvent);
          }

          const transactionEntity = tx.create(WagerTransactionEntity, {
            id: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            idempotencyKey: transaction.idempotencyKey,
            payloadHash: transaction.payloadHash,
            walletId: transaction.walletId,
            playerId: transaction.playerId,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: transaction.kind,
            amount: transaction.money.toJSON().amount,
            currency: transaction.money.currency,
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId,
            referenceTransactionId: transaction.referenceTransactionId,
            status: transaction.status,
            failureCode: transaction.failureCode,
            createdAt: transaction.createdAt,
            processedAt: transaction.processedAt,
            resultBalanceAmount: wallet.balance.toJSON().amount,
            resultBalanceCurrency: wallet.balance.currency,
          });

          const eventType =
            transaction.status === WagerTransactionStatus.Rejected
              ? 'WagerTransactionRejected'
              : 'WagerTransactionProcessed';

          const transactionEvent = tx.create(OutboxMessageEntity, {
            id: randomUUID(),
            aggregateId: transaction.id,
            eventType,
            payload: {
              version: 1,
              transactionId: transaction.id,
              walletId: wallet.id,
              providerId: transaction.providerId,
              kind: transaction.kind,
              status: transaction.status,
              failureCode: transaction.failureCode,
            },
            occurredAt: now,
            attempts: 0,
          });

          tx.persist(transactionEntity);
          tx.persist(transactionEvent);

          await tx.flush();

          return {
            transactionId: transaction.id,
            status: transaction.status,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
            failureCode: transaction.failureCode,
          };
        });
      } catch (error) {
        const canRetry =
          attempt < MAX_CONCURRENCY_RETRIES &&
          (error instanceof OptimisticLockError ||
            this.isRetryableTransactionUniqueConstraint(error));

        if (!canRetry) {
          throw error;
        }

        await this.waitBeforeRetry(attempt);
      }
    }

    throw new Error('Concurrency retry limit exhausted');
  }

  private isRetryableTransactionUniqueConstraint(error: unknown): boolean {
    if (!(error instanceof UniqueConstraintViolationException)) {
      return false;
    }

    const constraint = (
      error as UniqueConstraintViolationException & {
        constraint?: unknown;
      }
    ).constraint;

    return (
      typeof constraint === 'string' &&
      RETRYABLE_TRANSACTION_UNIQUE_CONSTRAINTS.has(constraint)
    );
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const delayMs = 10 * 2 ** (attempt - 1);

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
