import { DecimalType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallets' })
@Unique({
  name: 'wallet_player_currency_unique',
  properties: ['playerId', 'currency'],
})
@Check({
  name: 'wallet_balance_non_negative',
  expression: 'balance >= 0',
})
@Check({
  name: 'wallet_version_positive',
  expression: 'version >= 1',
})
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    type: 'string',
    fieldName: 'player_id',
  })
  playerId!: string;

  @Property({
    type: 'string',
    length: 3,
  })
  currency!: string;

  @Property({
    type: DecimalType,
    precision: 18,
    scale: 2,
  })
  balance!: string;

  @Property({
    type: 'integer',
    version: true,
    default: 1,
  })
  version = 1;

  @Property({
    type: 'datetime',
    fieldName: 'created_at',
  })
  createdAt!: Date;

  @Property({
    type: 'datetime',
    fieldName: 'updated_at',
  })
  updatedAt!: Date;
}