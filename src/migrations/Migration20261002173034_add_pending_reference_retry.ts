import { Migration } from '@mikro-orm/migrations';

export class Migration20261002173034_add_pending_reference_retry extends Migration {
  override name = 'Migration20261002173034_add_pending_reference_retry';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "reference_retry_attempts" int not null default 0, add "reference_next_attempt_at" timestamptz null;`);
    this.addSql(`create index "wager_transaction_pending_reference_due_idx" on "wager_transactions" ("reference_next_attempt_at", "created_at") where status = 'PENDING_REFERENCE';`);

    this.addSql(`drop trigger if exists "wallet_ledger_prevent_update_delete" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_wallet_ledger_prevent_update_delete_fn"();`);
    this.addSql(`create or replace function "wallet_ledger_entries_wallet_ledger_prevent_update_delete_fn"() returns trigger as $$ begin raise exception 'wallet ledger entries are immutable'; end; $$ language plpgsql;`);
    this.addSql(`create trigger "wallet_ledger_prevent_update_delete" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_wallet_ledger_prevent_update_delete_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wager_transaction_pending_reference_due_idx";`);
    this.addSql(`alter table "wager_transactions" drop column "reference_retry_attempts", drop column "reference_next_attempt_at";`);

    this.addSql(`drop trigger if exists "wallet_ledger_prevent_update_delete" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_wallet_ledger_prevent_update_delete_fn"();`);
    this.addSql(`create trigger "wallet_ledger_prevent_update_delete" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "prevent_wallet_ledger_mutation"();`);
  }
}
