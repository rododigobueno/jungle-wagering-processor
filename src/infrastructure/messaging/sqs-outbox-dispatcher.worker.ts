import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';

import { DispatchOutboxMessagesUseCase } from '../../application/messaging/dispatch-outbox-messages.use-case.js';
import { SqsMessagePublisher } from './sqs-message-publisher.js';

@Injectable()
export class SqsOutboxDispatcherWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SqsOutboxDispatcherWorker.name);
  private client?: SQSClient;
  private dispatcher?: DispatchOutboxMessagesUseCase;
  private running = false;
  private loopPromise?: Promise<void>;

  constructor(private readonly em: EntityManager) {}

  onApplicationBootstrap(): void {
    if (process.env.SQS_OUTBOX_DISPATCHER_ENABLED !== 'true') {
      return;
    }

    const queueUrl = process.env.SQS_OUTBOX_QUEUE_URL;
    if (!queueUrl) {
      throw new Error(
        'SQS_OUTBOX_QUEUE_URL is required when the outbox dispatcher is enabled',
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

    const publisher = new SqsMessagePublisher(this.client, queueUrl);
    this.dispatcher = new DispatchOutboxMessagesUseCase(this.em, publisher);

    this.running = true;
    this.loopPromise = this.runLoop();
    void this.loopPromise.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Outbox dispatcher loop stopped: ${message}`);
    });

    this.logger.log('SQS outbox dispatcher started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    this.client?.destroy();

    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }
  }

  private async runLoop(): Promise<void> {
    if (!this.dispatcher) {
      return;
    }

    while (this.running) {
      try {
        const result = await this.dispatcher.execute(10);
        const processed = result.published + result.retryScheduled;

        if (processed === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch (error) {
        if (!this.running) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Outbox dispatch failed: ${message}`);

        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
}
