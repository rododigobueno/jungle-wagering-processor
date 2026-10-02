import { describe, expect, it } from 'vitest';
import { Money } from '../money/money.js';
import { Wallet } from './wallet.js';

describe('Wallet', () => {
  it('abre uma wallet com saldo inicial e version 1', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
    });

    expect(wallet.balance.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });

    expect(wallet.version).toBe(1);
  });

  it('permite abrir uma wallet com saldo zero', () => {
    const wallet = Wallet.open({
      id: 'wallet-zero',
      playerId: 'player-zero',
      initialBalance: Money.zero('BRL'),
    });

    expect(wallet.balance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });

    expect(wallet.version).toBe(1);
  });

  it('debita o saldo e incrementa a versão', () => {
    const wallet = createWallet('100.00');

    wallet.debit(
      Money.from({
        amount: '25.00',
        currency: 'BRL',
      }),
    );

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
  });

  it('credita o saldo e incrementa a versão', () => {
    const wallet = createWallet('100.00');

    wallet.credit(
      Money.from({
        amount: '50.00',
        currency: 'BRL',
      }),
    );

    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(wallet.version).toBe(2);
  });

  it('não permite saldo negativo', () => {
    const wallet = createWallet('20.00');

    expect(() =>
      wallet.debit(
        Money.from({
          amount: '80.00',
          currency: 'BRL',
        }),
      ),
    ).toThrow();

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  it('rejeita movimentação em moeda diferente', () => {
    const wallet = createWallet('100.00');

    expect(() =>
      wallet.credit(
        Money.from({
          amount: '10.00',
          currency: 'USD',
        }),
      ),
    ).toThrow();

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('não incrementa a versão quando o saldo não muda', () => {
    const wallet = createWallet('100.00');

    wallet.credit(Money.zero('BRL'));

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

function createWallet(initialBalance: string): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({
      amount: initialBalance,
      currency: 'BRL',
    }),
  });
}