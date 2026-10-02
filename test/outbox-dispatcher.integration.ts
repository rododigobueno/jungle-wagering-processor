import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DispatchOutboxMessagesUseCase } from '../src/application/messaging/dispatch-outbox-messages.use-case.js';
import type { MessagePublisher } from '../src/application/messaging/message-publisher.js';
import { OutboxMessageEntity } from '../src/infrastructure/database/entities/outbox-message.entity.js';
import { SqsMessagePublisher } from '../src/infrastructure/messaging/sqs-message-publisher.js';

const postgresBaseConfig = {
  host: 'localhost',
  port: 5432,
  user: 'jungle',
  password: 'jungle',
};

const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

let orm: MikroORM;
let testDatabaseName = '';
let queueUrl = '';

beforeAll(async () => {
  testDatabaseName = `jungle_outbox_it_${randomUUID().replaceAll('-', '')}`;

  const adminOrm = await MikroORM.init({
    ...postgresBaseConfig,
    dbName: 'postgres',
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });

  await adminOrm.schema.createDatabase(testDatabaseName);
  await adminOrm.close(true);

  orm = await MikroORM.init({
    ...postgresBaseConfig,
    dbName: testDatabaseName,
    entities: [OutboxMessageEntity],
  });

  await orm.schema.create();

  const queue = await sqs.send(
    new CreateQueueCommand({ QueueName: `outbox-it-${randomUUID()}` }),
  );

  if (!queue.QueueUrl) {
    throw new Error('LocalStack did not return a queue URL');
  }

  queueUrl = queue.QueueUrl;
});

afterAll(async () => {
  if (queueUrl) {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  }

  sqs.destroy();
  await orm.close(true);

  const adminOrm = await MikroORM.init({
    ...postgresBaseConfig,
    dbName: 'postgres',
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });

  await adminOrm.schema.dropDatabase(testDatabaseName);
  await adminOrm.close(true);
});

describe('DispatchOutboxMessagesUseCase integration', () => {
  it('publishes a pending outbox message and marks it as published', async () => {
    const em = orm.em.fork();
    const messageId = randomUUID();

    const entity = em.create(OutboxMessageEntity, {
      id: messageId,
      aggregateId: randomUUID(),
      eventType: 'WalletBalanceChanged',
      payload: {
        walletId: randomUUID(),
        balanceAfter: { amount: '20.00', currency: 'BRL' },
      },
      occurredAt: new Date('2026-10-02T12:00:00.000Z'),
      attempts: 0,
    });

    em.persist(entity);
    await em.flush();

    const publisher = new SqsMessagePublisher(sqs, queueUrl);
    const dispatcher = new DispatchOutboxMessagesUseCase(
      orm.em.fork(),
      publisher,
    );

    const result = await dispatcher.execute(1);

    expect(result).toEqual({ published: 1, retryScheduled: 0 });

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );

    expect(received.Messages).toHaveLength(1);

    const body = JSON.parse(received.Messages?.[0]?.Body ?? '{}');
    expect(body.messageId).toBe(messageId);

    const verifyEm = orm.em.fork({ clear: true });
    const stored = await verifyEm.findOneOrFail(OutboxMessageEntity, {
      id: messageId,
    });

    expect(stored.publishedAt).toBeInstanceOf(Date);
    expect(stored.attempts).toBe(0);
    expect(stored.nextAttemptAt).toBeNull();
  });

  it('schedules a retry when publishing fails', async () => {
    const em = orm.em.fork();
    const messageId = randomUUID();
    const occurredAt = new Date();

    const entity = em.create(OutboxMessageEntity, {
      id: messageId,
      aggregateId: randomUUID(),
      eventType: 'WagerTransactionProcessed',
      payload: { transactionId: randomUUID() },
      occurredAt,
      attempts: 0,
    });

    em.persist(entity);
    await em.flush();

    const failingPublisher: MessagePublisher = {
      publish: async () => {
        throw new Error('SQS temporarily unavailable');
      },
    };

    const dispatcher = new DispatchOutboxMessagesUseCase(
      orm.em.fork(),
      failingPublisher,
    );

    const result = await dispatcher.execute(1);

    expect(result).toEqual({ published: 0, retryScheduled: 1 });

    const verifyEm = orm.em.fork({ clear: true });
    const stored = await verifyEm.findOneOrFail(OutboxMessageEntity, {
      id: messageId,
    });

    expect(stored.publishedAt).toBeNull();
    expect(stored.attempts).toBe(1);
    expect(stored.nextAttemptAt).toBeInstanceOf(Date);
    expect(stored.nextAttemptAt?.getTime()).toBeGreaterThan(
      occurredAt.getTime(),
    );
  });

  it('skips a row already locked by another dispatcher', async () => {
    const em = orm.em.fork();
    const messageId = randomUUID();

    const entity = em.create(OutboxMessageEntity, {
      id: messageId,
      aggregateId: randomUUID(),
      eventType: 'WalletBalanceChanged',
      payload: { walletId: randomUUID() },
      occurredAt: new Date(),
      attempts: 0,
    });

    em.persist(entity);
    await em.flush();

    const realPublisher = new SqsMessagePublisher(sqs, queueUrl);
    let publishStarted!: () => void;
    let releasePublish!: () => void;
    let publishCount = 0;

    const publishStartedPromise = new Promise<void>((resolve) => {
      publishStarted = resolve;
    });
    const releasePublishPromise = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });

    const countingPublisher: MessagePublisher = {
      publish: async (input) => {
        publishCount += 1;
        await realPublisher.publish(input);
      },
    };

    const blockingPublisher: MessagePublisher = {
      publish: async (input) => {
        publishStarted();
        await releasePublishPromise;
        await countingPublisher.publish(input);
      },
    };

    const dispatcherA = new DispatchOutboxMessagesUseCase(
      orm.em.fork(),
      blockingPublisher,
    );
    const dispatcherB = new DispatchOutboxMessagesUseCase(
      orm.em.fork(),
      countingPublisher,
    );

    const runA = dispatcherA.execute(1);
    await publishStartedPromise;

    const runB = dispatcherB.execute(1);
    const raceResult = await Promise.race([
      runB.then((result) => ({ completed: true as const, result })),
      new Promise<{ completed: false }>((resolve) =>
        setTimeout(() => resolve({ completed: false }), 500),
      ),
    ]);

    releasePublish();

    const resultA = await runA;
    const resultB = await runB;

    expect(raceResult.completed).toBe(true);
    expect(resultA).toEqual({ published: 1, retryScheduled: 0 });
    expect(resultB).toEqual({ published: 0, retryScheduled: 0 });
    expect(publishCount).toBe(1);

    const verifyEm = orm.em.fork({ clear: true });
    const stored = await verifyEm.findOneOrFail(OutboxMessageEntity, {
      id: messageId,
    });
    expect(stored.publishedAt).toBeInstanceOf(Date);
  });
});
