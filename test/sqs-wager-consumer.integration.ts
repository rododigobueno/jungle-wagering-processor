import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProcessWagerMessageUseCase } from '../src/application/wagering/process-wager-message.use-case.js';
import { WagerTransactionKind } from '../src/domain/wagering/wager-transaction.js';
import { InboxMessageEntity } from '../src/infrastructure/database/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../src/infrastructure/database/entities/outbox-message.entity.js';
import { WagerTransactionEntity } from '../src/infrastructure/database/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/infrastructure/database/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../src/infrastructure/database/entities/wallet.entity.js';
import { SqsWagerMessageConsumer } from '../src/infrastructure/messaging/sqs-wager-message-consumer.js';
import { CreateWalletUseCase } from '../src/application/wallet/create-wallet.use-case.js';

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
const queueUrls: string[] = [];

beforeAll(async () => {
  testDatabaseName = `jungle_consumer_it_${randomUUID().replaceAll('-', '')}`;

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
    entities: [
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
    ],
  });

  await orm.schema.create();
});

afterAll(async () => {
  for (const queueUrl of queueUrls) {
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

async function createQueue(visibilityTimeoutSeconds = 30): Promise<string> {
  const result = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-consumer-it-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: String(visibilityTimeoutSeconds),
      },
    }),
  );

  if (!result.QueueUrl) {
    throw new Error('LocalStack did not return a queue URL');
  }

  queueUrls.push(result.QueueUrl);
  return result.QueueUrl;
}

async function sendMessage(
  queueUrl: string,
  body: Record<string, unknown>,
  groupId: string,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function createQueueWithDlq(): Promise<{
  queueUrl: string;
  dlqUrl: string;
}> {
  const suffix = randomUUID();
  const dlq = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-consumer-it-dlq-${suffix}.fifo`,
      Attributes: { FifoQueue: 'true' },
    }),
  );

  if (!dlq.QueueUrl) throw new Error('LocalStack did not return a DLQ URL');
  queueUrls.push(dlq.QueueUrl);

  const attributes = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const dlqArn = attributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error('LocalStack did not return a DLQ ARN');

  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: `wager-consumer-it-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '1',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: '2',
        }),
      },
    }),
  );

  if (!queue.QueueUrl) throw new Error('LocalStack did not return a queue URL');
  queueUrls.push(queue.QueueUrl);

  return { queueUrl: queue.QueueUrl, dlqUrl: dlq.QueueUrl };
}

describe('SqsWagerMessageConsumer integration', () => {
  it('processes and ACKs a valid FIFO message after the database commit', async () => {
    const queueUrl = await createQueue();
    const createWallet = new CreateWalletUseCase(orm.em.fork());
    const wallet = await createWallet.execute({
      playerId: `player-sqs-${randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const messageId = `message-sqs-${randomUUID()}`;
    const body = {
      messageId,
      transaction: {
        idempotencyKey: `idem-sqs-${randomUUID()}`,
        providerId: 'integration-provider',
        externalTransactionId: `ext-sqs-${randomUUID()}`,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: `round-sqs-${randomUUID()}`,
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      },
    };

    await sendMessage(queueUrl, body, wallet.id);

    const handler = new ProcessWagerMessageUseCase(orm.em.fork());
    const errors: unknown[] = [];
    const consumer = new SqsWagerMessageConsumer(sqs, queueUrl, handler, {
      waitTimeSeconds: 0,
      maxMessages: 1,
      onError: (error) => errors.push(error),
    });

    const result = await consumer.pollOnce();

    if (errors[0]) {
      throw errors[0];
    }

    expect(result).toEqual({ received: 1, acknowledged: 1, failed: 0 });

    const verifyEm = orm.em.fork({ clear: true });
    const storedWallet = await verifyEm.findOneOrFail(WalletEntity, {
      id: wallet.id,
    });
    const inbox = await verifyEm.find(InboxMessageEntity, {
      consumerName: 'wager-transactions-consumer',
      messageId,
    });

    expect(storedWallet.balance).toBe('20.00');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].processedAt).toBeInstanceOf(Date);

    const emptyPoll = await consumer.pollOnce();
    expect(emptyPoll).toEqual({ received: 0, acknowledged: 0, failed: 0 });
  });

  it('does not ACK a failed message and receives it again after visibility timeout', async () => {
    const queueUrl = await createQueue(1);
    const messageId = `message-failure-${randomUUID()}`;
    const body = {
      messageId,
      transaction: {
        idempotencyKey: `idem-failure-${randomUUID()}`,
        providerId: 'integration-provider',
        externalTransactionId: `ext-failure-${randomUUID()}`,
        walletId: randomUUID(),
        playerId: `missing-player-${randomUUID()}`,
        roundId: `round-failure-${randomUUID()}`,
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      },
    };

    await sendMessage(queueUrl, body, body.transaction.walletId);

    const handler = new ProcessWagerMessageUseCase(orm.em.fork());
    const consumer = new SqsWagerMessageConsumer(sqs, queueUrl, handler, {
      waitTimeSeconds: 2,
      maxMessages: 1,
    });

    const first = await consumer.pollOnce();
    expect(first).toEqual({ received: 1, acknowledged: 0, failed: 1 });

    const second = await consumer.pollOnce();
    expect(second).toEqual({ received: 1, acknowledged: 0, failed: 1 });

    const verifyEm = orm.em.fork({ clear: true });
    const inbox = await verifyEm.find(InboxMessageEntity, {
      consumerName: 'wager-transactions-consumer',
      messageId,
    });
    expect(inbox).toHaveLength(0);
  });

  it('moves a repeatedly failing message to the FIFO DLQ', async () => {
    const { queueUrl, dlqUrl } = await createQueueWithDlq();
    const messageId = `message-dlq-${randomUUID()}`;
    const body = {
      messageId,
      transaction: {
        idempotencyKey: `idem-dlq-${randomUUID()}`,
        providerId: 'integration-provider',
        externalTransactionId: `ext-dlq-${randomUUID()}`,
        walletId: randomUUID(),
        playerId: `missing-player-${randomUUID()}`,
        roundId: `round-dlq-${randomUUID()}`,
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      },
    };

    await sendMessage(queueUrl, body, body.transaction.walletId);

    const handler = new ProcessWagerMessageUseCase(orm.em.fork());
    const consumer = new SqsWagerMessageConsumer(sqs, queueUrl, handler, {
      waitTimeSeconds: 2,
      maxMessages: 1,
    });

    expect(await consumer.pollOnce()).toEqual({
      received: 1,
      acknowledged: 0,
      failed: 1,
    });
    expect(await consumer.pollOnce()).toEqual({
      received: 1,
      acknowledged: 0,
      failed: 1,
    });

    await consumer.pollOnce();

    const dlqMessage = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );

    expect(dlqMessage.Messages).toHaveLength(1);
    expect(JSON.parse(dlqMessage.Messages?.[0]?.Body ?? '{}')).toEqual(body);
  });
});
