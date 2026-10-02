import { describe, expect, it } from 'vitest';
import { InboxMessage } from './inbox-message.js';
import { OutboxMessage } from './outbox-message.js';

describe('InboxMessage', () => {
  it('nasce como não processada', () => {
    const inbox = InboxMessage.receive({
      messageId: 'message-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-123',
      receivedAt: new Date(),
    });

    expect(inbox.isProcessed()).toBe(false);
  });

  it('pode ser marcada como processada', () => {
    const inbox = InboxMessage.receive({
      messageId: 'message-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-123',
      receivedAt: new Date(),
    });

    inbox.markProcessed(new Date());

    expect(inbox.isProcessed()).toBe(true);
  });

  it('não permite processar duas vezes', () => {
    const inbox = InboxMessage.receive({
      messageId: 'message-1',
      consumerName: 'wager-consumer',
      payloadHash: 'hash-123',
      receivedAt: new Date(),
    });

    inbox.markProcessed(new Date());

    expect(() => inbox.markProcessed(new Date())).toThrow();
  });
});

describe('OutboxMessage', () => {
  it('nasce pendente para publicação', () => {
    const outbox = OutboxMessage.enqueue({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: {
        walletId: 'wallet-1',
      },
      occurredAt: new Date(),
    });

    expect(outbox.isPending()).toBe(true);
    expect(outbox.attempts).toBe(0);
  });

  it('pode ser marcada como publicada', () => {
    const outbox = OutboxMessage.enqueue({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: {
        walletId: 'wallet-1',
      },
      occurredAt: new Date(),
    });

    outbox.markPublished(new Date());

    expect(outbox.isPending()).toBe(false);
  });

  it('agenda retry após falha', () => {
    const outbox = OutboxMessage.enqueue({
      id: 'event-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: {
        walletId: 'wallet-1',
      },
      occurredAt: new Date(),
    });

    const now = new Date();

    outbox.scheduleRetry(now);

    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt).toBeDefined();
    expect(outbox.isDue(now)).toBe(false);
  });
});