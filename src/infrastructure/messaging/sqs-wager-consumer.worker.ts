import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';

import { ProcessWagerMessageUseCase } from '../../application/wagering/process-wager-message.use-case.js';
import { SqsWagerMessageConsumer } from './sqs-wager-message-consumer.js';

@Injectable()
export class SqsWagerConsumerWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SqsWagerConsumerWorker.name);
  private client?: SQSClient;
  private consumer?: SqsWagerMessageConsumer;
  private running = false;
  private loopPromise?: Promise<void>;

  constructor(private readonly em: EntityManager) {}

  onApplicationBootstrap(): void {
    if (process.env.SQS_WAGER_CONSUMER_ENABLED !== 'true') {
      return;
    }

    const queueUrl = process.env.SQS_WAGER_QUEUE_URL;
    if (!queueUrl) {
      throw new Error(
        'SQS_WAGER_QUEUE_URL is required when the wager consumer is enabled',
      );
    }

    const endpoint = process.env.SQS_ENDPOINT_URL;
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      ...(endpoint
        ? {
            endpoint,
            credentials: {
              accessKeyId: 'test',
              secretAccessKey: 'test',
            },
          }
        : {}),
    });

    const handler = new ProcessWagerMessageUseCase(this.em);
    this.consumer = new SqsWagerMessageConsumer(
      this.client,
      queueUrl,
      handler,
      {
        waitTimeSeconds: 20,
        maxMessages: 10,
        onError: (error, message) => {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Wager message failed: ${message.MessageId ?? 'unknown'} - ${errorMessage}`,
          );
        },
      },
    );

    this.running = true;
    this.loopPromise = this.runLoop();
    void this.loopPromise.catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Wager consumer loop stopped: ${errorMessage}`);
    });

    this.logger.log('SQS wager consumer started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    this.client?.destroy();

    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }
  }

  private async runLoop(): Promise<void> {
    if (!this.consumer) {
      return;
    }

    while (this.running) {
      try {
        await this.consumer.pollOnce();
      } catch (error) {
        if (!this.running) {
          break;
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(`SQS receive failed: ${errorMessage}`);

        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
}
