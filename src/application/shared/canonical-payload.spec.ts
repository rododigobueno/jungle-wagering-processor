import { describe, expect, it } from 'vitest';
import { createPayloadHash } from './canonical-payload.js';

describe('createPayloadHash', () => {
  it('gera o mesmo hash independentemente da ordem das chaves', () => {
    const first = createPayloadHash({
      providerId: 'provider-1',
      amount: {
        amount: '25.00',
        currency: 'BRL',
      },
    });

    const second = createPayloadHash({
      amount: {
        currency: 'BRL',
        amount: '25.00',
      },
      providerId: 'provider-1',
    });

    expect(first).toBe(second);
  });

  it('gera hash diferente quando o conteúdo de negócio muda', () => {
    const first = createPayloadHash({
      amount: '25.00',
    });

    const second = createPayloadHash({
      amount: '30.00',
    });

    expect(first).not.toBe(second);
  });
});