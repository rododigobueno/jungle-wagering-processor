import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @PrimaryKey({
    type: 'string',
    fieldName: 'consumer_name',
  })
  consumerName!: string;

  @PrimaryKey({
    type: 'string',
    fieldName: 'message_id',
  })
  messageId!: string;

  @Property({
    type: 'string',
    fieldName: 'payload_hash',
  })
  payloadHash!: string;

  @Property({
    type: 'datetime',
    fieldName: 'received_at',
  })
  receivedAt!: Date;

  @Property({
    type: 'datetime',
    fieldName: 'processed_at',
    nullable: true,
  })
  processedAt?: Date;
}