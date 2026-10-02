import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OutboxMessageEntity } from '../src/infrastructure/database/entities/outbox-message.entity.js';
import { SqsOutboxDispatcherWorker } from '../src/infrastructure/messaging/sqs-outbox-dispatcher.worker.js';

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
  testDatabaseName = `jungle_outbox_worker_it_${randomUUID().replaceAll('-', '')}`;

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
    new CreateQueueCommand({
      QueueName: `outbox-worker-it-${randomUUID()}`,
    }),
  );

  if (!queue.QueueUrl) throw new Error('LocalStack did not return a queue URL');
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

describe('SqsOutboxDispatcherWorker integration', () => {
  it('publishes pending Outbox messages in the background', async () => {
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

    const previousEnabled = process.env.SQS_OUTBOX_DISPATCHER_ENABLED;
    const previousQueueUrl = process.env.SQS_OUTBOX_QUEUE_URL;
    const previousEndpoint = process.env.SQS_ENDPOINT_URL;

    process.env.SQS_OUTBOX_DISPATCHER_ENABLED = 'true';
    process.env.SQS_OUTBOX_QUEUE_URL = queueUrl;
    process.env.SQS_ENDPOINT_URL = 'http://localhost:4566';

    const worker = new SqsOutboxDispatcherWorker(orm.em.fork());

    try {
      worker.onApplicationBootstrap();

      const published = await waitForPublished(messageId);
      expect(published.publishedAt).toBeInstanceOf(Date);

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
    } finally {
      await worker.onApplicationShutdown();
      restoreEnv('SQS_OUTBOX_DISPATCHER_ENABLED', previousEnabled);
      restoreEnv('SQS_OUTBOX_QUEUE_URL', previousQueueUrl);
      restoreEnv('SQS_ENDPOINT_URL', previousEndpoint);
    }
  });
});

async function waitForPublished(
  messageId: string,
): Promise<OutboxMessageEntity> {
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    const em = orm.em.fork({ clear: true });
    const entity = await em.findOne(OutboxMessageEntity, { id: messageId });

    if (entity?.publishedAt) {
      return entity;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Outbox worker did not publish the message in time');
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
