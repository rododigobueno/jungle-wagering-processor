import { describe, expect, it } from 'vitest';
import { Money } from './money.js';

describe('Money', () => {
  it('normaliza um valor válido para duas casas decimais', () => {
    const money = Money.from({
      amount: '25',
      currency: 'BRL',
    });

    expect(money.toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  it('soma valores da mesma moeda com precisão decimal', () => {
    const first = Money.from({
      amount: '0.10',
      currency: 'BRL',
    });

    const second = Money.from({
      amount: '0.20',
      currency: 'BRL',
    });

    expect(first.add(second).toJSON()).toEqual({
      amount: '0.30',
      currency: 'BRL',
    });
  });

  it('subtrai valores da mesma moeda com precisão decimal', () => {
    const balance = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const bet = Money.from({
      amount: '25.00',
      currency: 'BRL',
    });

    expect(balance.subtract(bet).toJSON()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
  });

  it('rejeita operações entre moedas diferentes', () => {
    const brl = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => brl.add(usd)).toThrow();
  });

  it.each([
    '',
    'NaN',
    'Infinity',
    '1e3',
    '10.123',
    '-1.00',
  ])('rejeita valor de entrada inválido: %s', (amount) => {
    expect(() =>
      Money.from({
        amount,
        currency: 'BRL',
      }),
    ).toThrow();
  });
});