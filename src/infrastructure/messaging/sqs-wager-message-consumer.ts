import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import type {
  ProcessWagerMessageInput,
  ProcessWagerMessageOutput,
} from '../../application/wagering/process-wager-message.use-case.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction.js';

export interface WagerMessageHandler {
  execute(input: ProcessWagerMessageInput): Promise<ProcessWagerMessageOutput>;
}

export interface SqsWagerMessageConsumerOptions {
  waitTimeSeconds?: number;
  maxMessages?: number;
  onError?: (error: unknown, message: Message) => void;
}

export interface PollWagerMessagesResult {
  received: number;
  acknowledged: number;
  failed: number;
}

export class SqsWagerMessageConsumer {
  private readonly waitTimeSeconds: number;
  private readonly maxMessages: number;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly handler: WagerMessageHandler,
    private readonly options: SqsWagerMessageConsumerOptions = {},
  ) {
    if (!queueUrl) {
      throw new Error('SQS queue URL is required');
    }

    this.waitTimeSeconds = options.waitTimeSeconds ?? 20;
    this.maxMessages = options.maxMessages ?? 10;

    if (this.waitTimeSeconds < 0 || this.waitTimeSeconds > 20) {
      throw new Error('SQS wait time must be between 0 and 20 seconds');
    }

    if (this.maxMessages < 1 || this.maxMessages > 10) {
      throw new Error('SQS max messages must be between 1 and 10');
    }
  }

  async pollOnce(): Promise<PollWagerMessagesResult> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: this.maxMessages,
        WaitTimeSeconds: this.waitTimeSeconds,
      }),
    );

    const messages = response.Messages ?? [];
    const result: PollWagerMessagesResult = {
      received: messages.length,
      acknowledged: 0,
      failed: 0,
    };

    for (const message of messages) {
      try {
        const input = parseWagerMessageBody(message.Body);
        await this.handler.execute(input);

        if (!message.ReceiptHandle) {
          throw new Error('SQS message does not have a receipt handle');
        }

        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );

        result.acknowledged += 1;
      } catch (error) {
        result.failed += 1;
        this.options.onError?.(error, message);
      }
    }

    return result;
  }
}

function parseWagerMessageBody(
  body: string | undefined,
): ProcessWagerMessageInput {
  if (!body) {
    throw new Error('SQS message body is required');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('SQS message body must be valid JSON');
  }

  const envelope = requireRecord(parsed, 'SQS message body');
  const transaction = requireRecord(envelope.transaction, 'transaction');
  const money = requireRecord(transaction.money, 'transaction.money');

  const kind = requireString(transaction.kind, 'transaction.kind');

  if (
    !Object.values(WagerTransactionKind).includes(kind as WagerTransactionKind)
  ) {
    throw new Error(`Unsupported wager transaction kind: ${kind}`);
  }

  return {
    messageId: requireString(envelope.messageId, 'messageId'),
    transaction: {
      idempotencyKey: requireString(
        transaction.idempotencyKey,
        'transaction.idempotencyKey',
      ),
      providerId: requireString(
        transaction.providerId,
        'transaction.providerId',
      ),
      externalTransactionId: requireString(
        transaction.externalTransactionId,
        'transaction.externalTransactionId',
      ),
      walletId: requireString(transaction.walletId, 'transaction.walletId'),
      playerId: requireString(transaction.playerId, 'transaction.playerId'),
      roundId: requireString(transaction.roundId, 'transaction.roundId'),
      gameId: requireString(transaction.gameId, 'transaction.gameId'),
      kind: kind as WagerTransactionKind,
      money: {
        amount: requireString(money.amount, 'transaction.money.amount'),
        currency: requireString(money.currency, 'transaction.money.currency'),
      },
      referenceExternalTransactionId: optionalString(
        transaction.referenceExternalTransactionId,
        'transaction.referenceExternalTransactionId',
      ),
    },
  };
}

function requireRecord(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value;
}

function optionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return requireString(value, fieldName);
}
