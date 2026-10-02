import { DecimalType } from '@mikro-orm/core';
import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Trigger,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallet_ledger_entries' })
@Trigger({
  name: 'wallet_ledger_prevent_update_delete',
  timing: 'before',
  events: ['update', 'delete'],
  forEach: 'row',
  body: "raise exception 'wallet ledger entries are immutable';",
})
@Unique({
  name: 'wallet_ledger_transaction_unique',
  properties: ['walletId', 'transactionId'],
})
@Check({
  name: 'ledger_amount_non_negative',
  expression: 'amount >= 0',
})
@Check({
  name: 'ledger_balance_before_non_negative',
  expression: 'balance_before >= 0',
})
@Check({
  name: 'ledger_balance_after_non_negative',
  expression: 'balance_after >= 0',
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    type: 'uuid',
    fieldName: 'wallet_id',
  })
  walletId!: string;

  @Property({
    type: 'uuid',
    fieldName: 'transaction_id',
  })
  transactionId!: string;

  @Property({ type: 'string' })
  direction!: string;

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
    type: DecimalType,
    precision: 18,
    scale: 2,
    fieldName: 'balance_before',
  })
  balanceBefore!: string;

  @Property({
    type: DecimalType,
    precision: 18,
    scale: 2,
    fieldName: 'balance_after',
  })
  balanceAfter!: string;

  @Property({
    type: 'datetime',
    fieldName: 'created_at',
  })
  createdAt!: Date;
}
