import { describe, expect, it } from 'vitest';
import { Money } from '../money/money.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';

describe('WagerTransaction', () => {
  it('cria uma BET em estado PENDING', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.requiresReference()).toBe(false);
  });

  it('LOSS não altera saldo', () => {
    const transaction = createTransaction(WagerTransactionKind.Loss);

    expect(transaction.affectsBalance()).toBe(false);
  });

  it('REFUND exige referência', () => {
    expect(() =>
      createTransaction(WagerTransactionKind.Refund),
    ).toThrow();
  });

  it('ROLLBACK exige referência', () => {
    expect(() =>
      createTransaction(WagerTransactionKind.Rollback),
    ).toThrow();
  });

  it('permite REFUND quando existe referência externa', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Refund,
      'bet-external-123',
    );

    expect(transaction.requiresReference()).toBe(true);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });

  it('pode ficar aguardando uma referência ainda não encontrada', () => {
    const transaction = createTransaction(
      WagerTransactionKind.Refund,
      'bet-external-123',
    );

    transaction.markPendingReference();

    expect(transaction.status).toBe(
      WagerTransactionStatus.PendingReference,
    );
  });

  it('PROCESSED é um estado terminal', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);

    transaction.markProcessed(undefined, new Date());

    expect(transaction.status).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(() =>
      transaction.reject('INSUFFICIENT_FUNDS'),
    ).toThrow();
  });

  it('REJECTED é um estado terminal', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);

    transaction.reject('INSUFFICIENT_FUNDS');

    expect(transaction.status).toBe(
      WagerTransactionStatus.Rejected,
    );

    expect(() =>
      transaction.markProcessed(undefined, new Date()),
    ).toThrow();
  });

  it('identifica replay pelo payloadHash', () => {
    const transaction = createTransaction(WagerTransactionKind.Bet);

    expect(transaction.matchesPayload('hash-123')).toBe(true);
    expect(transaction.matchesPayload('hash-different')).toBe(false);
  });
});

function createTransaction(
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-1',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-1:external-1',
    payloadHash: 'hash-123',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.from({
      amount: '25.00',
      currency: 'BRL',
    }),
    referenceExternalTransactionId,
    createdAt: new Date(),
  });
}