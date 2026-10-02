import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SqsMessagePublisher } from '../src/infrastructure/messaging/sqs-message-publisher.js';

const client = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

let queueUrl = '';

describe('SqsMessagePublisher integration', () => {
  beforeAll(async () => {
    const result = await client.send(
      new CreateQueueCommand({
        QueueName: `jungle-it-${randomUUID()}`,
      }),
    );

    if (!result.QueueUrl) {
      throw new Error('LocalStack did not return a queue URL');
    }

    queueUrl = result.QueueUrl;
  });

  afterAll(async () => {
    if (queueUrl) {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }

    client.destroy();
  });

  it('publishes a stable event envelope to SQS', async () => {
    const publisher = new SqsMessagePublisher(client, queueUrl);
    const occurredAt = new Date('2026-10-02T12:00:00.000Z');

    await publisher.publish({
      messageId: 'event-123',
      aggregateId: 'wallet-456',
      eventType: 'WalletBalanceChanged',
      occurredAt,
      payload: {
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '20.00', currency: 'BRL' },
      },
    });

    const received = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );

    expect(received.Messages).toHaveLength(1);

    const body = JSON.parse(received.Messages?.[0]?.Body ?? '{}');

    expect(body).toEqual({
      messageId: 'event-123',
      aggregateId: 'wallet-456',
      eventType: 'WalletBalanceChanged',
      occurredAt: '2026-10-02T12:00:00.000Z',
      payload: {
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '20.00', currency: 'BRL' },
      },
    });
  });
});
