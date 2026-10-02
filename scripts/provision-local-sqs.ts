import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const endpoint = process.env.SQS_ENDPOINT_URL ?? 'http://localhost:4566';
const region = process.env.AWS_REGION ?? 'us-east-1';
const queueName = process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo';
const dlqName = process.env.SQS_WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo';
const visibilityTimeout = process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? '30';
const maxReceiveCount = process.env.SQS_MAX_RECEIVE_COUNT ?? '5';

const client = new SQSClient({
  region,
  endpoint,
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

const dlqUrl = await getOrCreateQueue(dlqName);
const dlqArn = await getQueueArn(dlqUrl);

const queueUrl = await getOrCreateQueue(queueName);

await client.send(
  new SetQueueAttributesCommand({
    QueueUrl: queueUrl,
    Attributes: {
      VisibilityTimeout: visibilityTimeout,
      ReceiveMessageWaitTimeSeconds: '20',
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount,
      }),
    },
  }),
);

console.log(`SQS_WAGER_QUEUE_URL=${queueUrl}`);
console.log(`SQS_WAGER_DLQ_URL=${dlqUrl}`);
console.log(`SQS_ENDPOINT_URL=${endpoint}`);

client.destroy();

async function getOrCreateQueue(name: string): Promise<string> {
  try {
    const existing = await client.send(
      new GetQueueUrlCommand({ QueueName: name }),
    );

    if (!existing.QueueUrl) {
      throw new Error(`SQS did not return a URL for ${name}`);
    }

    return existing.QueueUrl;
  } catch (error) {
    if (!isQueueMissing(error)) {
      throw error;
    }
  }

  const created = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true' },
    }),
  );

  if (!created.QueueUrl) {
    throw new Error(`SQS did not return a URL after creating ${name}`);
  }

  return created.QueueUrl;
}

async function getQueueArn(queueUrl: string): Promise<string> {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );

  const queueArn = result.Attributes?.QueueArn;
  if (!queueArn) {
    throw new Error(`SQS did not return an ARN for ${queueUrl}`);
  }

  return queueArn;
}

function isQueueMissing(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === 'QueueDoesNotExist' ||
    error.name === 'AWS.SimpleQueueService.NonExistentQueue'
  );
}
