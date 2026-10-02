import { describe, expect, it } from 'vitest';
import { Money } from '../money/money.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry.js';

describe('WalletLedgerEntry', () => {
  it('cria um lançamento de débito balanceado', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Debit,
      money: money('25.00'),
      balanceBefore: money('100.00'),
      balanceAfter: money('75.00'),
      createdAt: new Date(),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('cria um lançamento de crédito balanceado', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: LedgerDirection.Credit,
      money: money('25.00'),
      balanceBefore: money('75.00'),
      balanceAfter: money('100.00'),
      createdAt: new Date(),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('rejeita um débito com cálculo incorreto', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-1',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: LedgerDirection.Debit,
        money: money('25.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('80.00'),
        createdAt: new Date(),
      }),
    ).toThrow();
  });

  it('rejeita um crédito com cálculo incorreto', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-1',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: LedgerDirection.Credit,
        money: money('25.00'),
        balanceBefore: money('75.00'),
        balanceAfter: money('90.00'),
        createdAt: new Date(),
      }),
    ).toThrow();
  });

  it('rejeita moedas incompatíveis', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-1',
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: LedgerDirection.Credit,
        money: Money.from({
          amount: '25.00',
          currency: 'USD',
        }),
        balanceBefore: money('75.00'),
        balanceAfter: money('100.00'),
        createdAt: new Date(),
      }),
    ).toThrow();
  });
});

function money(amount: string): Money {
  return Money.from({
    amount,
    currency: 'BRL',
  });
}