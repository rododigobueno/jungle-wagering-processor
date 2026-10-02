import { Migration } from '@mikro-orm/migrations';

export class Migration20261002141000_add_processed_reversal_unique extends Migration {
  override name = 'Migration20261002141000_add_processed_reversal_unique';

  override up(): void | Promise<void> {
    this.addSql(`
      create unique index "wager_transaction_processed_reversal_unique"
      on "wager_transactions" ("reference_transaction_id", "kind")
      where "reference_transaction_id" is not null
        and "status" = 'PROCESSED'
        and "kind" in ('REFUND', 'ROLLBACK');
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      drop index if exists "wager_transaction_processed_reversal_unique";
    `);
  }
}
