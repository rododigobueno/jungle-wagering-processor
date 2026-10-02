import { Migration } from '@mikro-orm/migrations';

export class Migration20261002010907_add_wager_transactions_and_ledger extends Migration {

  override name = 'Migration20261002010907_add_wager_transactions_and_ledger';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(255) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(255) not null, "wallet_id" uuid not null, "player_id" varchar(255) not null, "round_id" varchar(255) not null, "game_id" varchar(255) not null, "kind" varchar(255) not null, "amount" numeric(18,2) not null, "currency" varchar(3) not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "status" varchar(255) not null, "failure_code" varchar(255) null, "created_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transaction_provider_external_unique" unique ("provider_id", "external_transaction_id");`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transaction_idempotency_key_unique" unique ("idempotency_key");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(255) not null, "amount" numeric(18,2) not null, "currency" varchar(3) not null, "balance_before" numeric(18,2) not null, "balance_after" numeric(18,2) not null, "created_at" timestamptz not null, primary key ("id"));`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_transaction_unique" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transaction_amount_non_negative" check (amount >= 0);`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_balance_after_non_negative" check (balance_after >= 0);`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_balance_before_non_negative" check (balance_before >= 0);`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_amount_non_negative" check (amount >= 0);`);

    this.addSql(`
      create function prevent_wallet_ledger_mutation()
      returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'wallet ledger entries are immutable';
      end;
      $$;
    `);

    this.addSql(`
      create trigger wallet_ledger_prevent_update_delete
      before update or delete on wallet_ledger_entries
      for each row
      execute function prevent_wallet_ledger_mutation();
    `);

    this.addSql(`
      create trigger wallet_ledger_prevent_truncate
      before truncate on wallet_ledger_entries
      for each statement
      execute function prevent_wallet_ledger_mutation();
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
    this.addSql(`drop function if exists prevent_wallet_ledger_mutation();`);
  }

}