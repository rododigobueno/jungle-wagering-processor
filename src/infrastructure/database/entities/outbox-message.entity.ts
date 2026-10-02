import { JsonType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
@Index({
  name: 'outbox_pending_index',
  properties: ['publishedAt', 'nextAttemptAt'],
})
@Check({
  name: 'outbox_attempts_non_negative',
  expression: 'attempts >= 0',
})
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    type: 'uuid',
    fieldName: 'aggregate_id',
  })
  aggregateId!: string;

  @Property({
    type: 'string',
    fieldName: 'event_type',
  })
  eventType!: string;

  @Property({
    type: JsonType,
  })
  payload!: Record<string, unknown>;

  @Property({
    type: 'datetime',
    fieldName: 'occurred_at',
  })
  occurredAt!: Date;

  @Property({
    type: 'integer',
    default: 0,
  })
  attempts = 0;

  @Property({
    type: 'datetime',
    fieldName: 'next_attempt_at',
    nullable: true,
  })
  nextAttemptAt?: Date;

  @Property({
    type: 'datetime',
    fieldName: 'published_at',
    nullable: true,
  })
  publishedAt?: Date;
}