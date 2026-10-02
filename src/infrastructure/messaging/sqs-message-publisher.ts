import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

import type {
  MessagePublisher,
  PublishMessageInput,
} from '../../application/messaging/message-publisher.js';

export class SqsMessagePublisher implements MessagePublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {
    if (!queueUrl) {
      throw new Error('SQS queue URL is required');
    }
  }

  async publish(input: PublishMessageInput): Promise<void> {
    const messageBody = JSON.stringify({
      messageId: input.messageId,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      occurredAt: input.occurredAt.toISOString(),
      payload: input.payload,
    });

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: messageBody,
      }),
    );
  }
}
