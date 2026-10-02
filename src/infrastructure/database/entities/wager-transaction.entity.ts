import { DecimalType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transactions' })
@Unique({
  name: 'wager_transaction_idempotency_key_unique',
  properties: ['idempotencyKey'],
})
@Unique({
  name: 'wager_transaction_provider_external_unique',
  properties: ['providerId', 'externalTransactionId'],
})
@Check({
  name: 'wager_transaction_amount_non_negative',
  expression: 'amount >= 0',
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', fieldName: 'provider_id' })
  providerId!: string;

  @Property({
    type: 'string',
    fieldName: 'external_transaction_id',
  })
  externalTransactionId!: string;

  @Property({
    type: 'string',
    fieldName: 'idempotency_key',
  })
  idempotencyKey!: string;

  @Property({
    type: 'string',
    fieldName: 'payload_hash',
  })
  payloadHash!: string;

  @Property({
    type: 'uuid',
    fieldName: 'wallet_id',
  })
  walletId!: string;

  @Property({
    type: 'string',
    fieldName: 'player_id',
  })
  playerId!: string;

  @Property({
    type: 'string',
    fieldName: 'round_id',
  })
  roundId!: string;

  @Property({
    type: 'string',
    fieldName: 'game_id',
  })
  gameId!: string;

  @Property({ type: 'string' })
  kind!: string;

  @Property({
    type: DecimalType,
    precision: 18,
    scale: 2,
  })
  amount!: string;

  @Property({
    type: 'string',
    length: 3,
  })
  currency!: string;

  @Property({
    type: 'string',
    fieldName: 'reference_external_transaction_id',
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @Property({
    type: 'uuid',
    fieldName: 'reference_transaction_id',
    nullable: true,
  })
  referenceTransactionId?: string;

  @Property({ type: 'string' })
  status!: string;

  @Property({
    type: 'string',
    fieldName: 'failure_code',
    nullable: true,
  })
  failureCode?: string;

  @Property({
    type: 'datetime',
    fieldName: 'created_at',
  })
  createdAt!: Date;

  @Property({
    type: 'datetime',
    fieldName: 'processed_at',
    nullable: true,
  })
  processedAt?: Date;
}