import { EntityManager } from '@mikro-orm/postgresql';

import { createPayloadHash } from '../shared/canonical-payload.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { InboxMessageEntity } from '../../infrastructure/database/entities/inbox-message.entity.js';
import {
  getUniqueConstraintName,
  runWithWagerConcurrencyRetry,
} from './wager-concurrency-retry.js';
import {
  processWagerTransactionInTransaction,
  type ProcessWagerTransactionInput,
  type ProcessWagerTransactionOutput,
} from './wager-transaction-processing.js';

const CONSUMER_NAME = 'wager-transactions-consumer';
const INBOX_PRIMARY_KEY_CONSTRAINT = 'inbox_messages_pkey';

export interface ProcessWagerMessageInput {
  messageId: string;
  transaction: ProcessWagerTransactionInput;
}

export interface ProcessWagerMessageOutput {
  inboxReplay: boolean;
  transaction?: ProcessWagerTransactionOutput;
}

export class InboxPayloadConflictError extends Error {
  constructor() {
    super('Inbox message ID already used with a different payload');
  }
}

export class ProcessWagerMessageUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(
    input: ProcessWagerMessageInput,
  ): Promise<ProcessWagerMessageOutput> {
    if (!input.messageId.trim()) {
      throw new Error('Message ID is required');
    }

    const payloadHash = createPayloadHash(input.transaction);

    return runWithWagerConcurrencyRetry(
      this.em,
      (tx) => this.executeInTransaction(tx, input, payloadHash),
      {
        additionalRetryableError: (error) =>
          getUniqueConstraintName(error) === INBOX_PRIMARY_KEY_CONSTRAINT,
      },
    );
  }

  private async executeInTransaction(
    tx: EntityManager,
    input: ProcessWagerMessageInput,
    payloadHash: string,
  ): Promise<ProcessWagerMessageOutput> {
    let entity = await tx.findOne(InboxMessageEntity, {
      consumerName: CONSUMER_NAME,
      messageId: input.messageId,
    });

    let inbox: InboxMessage;

    if (entity) {
      if (entity.payloadHash !== payloadHash) {
        throw new InboxPayloadConflictError();
      }

      inbox = InboxMessage.rehydrate({
        messageId: entity.messageId,
        consumerName: entity.consumerName,
        payloadHash: entity.payloadHash,
        receivedAt: entity.receivedAt,
        processedAt: entity.processedAt ?? undefined,
      });

      if (inbox.isProcessed()) {
        return { inboxReplay: true };
      }
    } else {
      const receivedAt = new Date();
      inbox = InboxMessage.receive({
        messageId: input.messageId,
        consumerName: CONSUMER_NAME,
        payloadHash,
        receivedAt,
      });

      entity = tx.create(InboxMessageEntity, {
        consumerName: inbox.consumerName,
        messageId: inbox.messageId,
        payloadHash: inbox.payloadHash,
        receivedAt: inbox.receivedAt,
      });

      tx.persist(entity);
    }

    const transaction = await processWagerTransactionInTransaction(
      tx,
      input.transaction,
    );

    inbox.markProcessed(new Date());
    entity.processedAt = inbox.processedAt;
    await tx.flush();

    return {
      inboxReplay: false,
      transaction,
    };
  }
}
