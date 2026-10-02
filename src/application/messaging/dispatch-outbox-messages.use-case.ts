import { LockMode, QueryOrder } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';

import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { OutboxMessageEntity } from '../../infrastructure/database/entities/outbox-message.entity.js';
import type { MessagePublisher } from './message-publisher.js';

export interface DispatchOutboxResult {
  published: number;
  retryScheduled: number;
}

type DispatchOutcome = 'NONE' | 'PUBLISHED' | 'RETRY_SCHEDULED';

export class DispatchOutboxMessagesUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly publisher: MessagePublisher,
  ) {}

  async execute(limit = 10): Promise<DispatchOutboxResult> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Dispatch limit must be a positive integer');
    }

    const result: DispatchOutboxResult = {
      published: 0,
      retryScheduled: 0,
    };

    for (let index = 0; index < limit; index++) {
      const outcome = await this.dispatchNext();

      if (outcome === 'NONE') {
        break;
      }

      if (outcome === 'PUBLISHED') {
        result.published += 1;
      } else {
        result.retryScheduled += 1;
      }
    }

    return result;
  }

  private async dispatchNext(): Promise<DispatchOutcome> {
    const em = this.em.fork();

    return em.transactional(async (tx) => {
      const now = new Date();
      const entity = await tx.findOne(
        OutboxMessageEntity,
        {
          publishedAt: null,
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        },
        {
          orderBy: {
            occurredAt: QueryOrder.ASC,
            id: QueryOrder.ASC,
          },
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        },
      );

      if (!entity) {
        return 'NONE';
      }

      const message = OutboxMessage.rehydrate({
        id: entity.id,
        aggregateId: entity.aggregateId,
        eventType: entity.eventType,
        payload: entity.payload,
        occurredAt: entity.occurredAt,
        attempts: entity.attempts,
        nextAttemptAt: entity.nextAttemptAt ?? undefined,
        publishedAt: entity.publishedAt ?? undefined,
      });

      try {
        await this.publisher.publish({
          messageId: message.id,
          aggregateId: message.aggregateId,
          eventType: message.eventType,
          payload: message.payload,
          occurredAt: message.occurredAt,
        });
      } catch {
        message.scheduleRetry(new Date());
        this.syncEntity(entity, message);
        await tx.flush();

        return 'RETRY_SCHEDULED';
      }

      message.markPublished(new Date());
      this.syncEntity(entity, message);
      await tx.flush();

      return 'PUBLISHED';
    });
  }

  private syncEntity(
    entity: OutboxMessageEntity,
    message: OutboxMessage,
  ): void {
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt;
    entity.publishedAt = message.publishedAt;
  }
}
