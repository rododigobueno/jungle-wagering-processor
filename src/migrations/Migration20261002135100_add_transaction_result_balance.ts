import { Migration } from '@mikro-orm/migrations';

export class Migration20261002135100_add_transaction_result_balance extends Migration {

  override name = 'Migration20261002135100_add_transaction_result_balance';

  override up(): void | Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
      add "result_balance_amount" numeric(18,2) null,
      add "result_balance_currency" varchar(3) null;
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
      drop column "result_balance_amount",
      drop column "result_balance_currency";
    `);
  }

}