import { Migration } from '@mikro-orm/migrations';

export class Migration20261002013126_add_inbox_and_outbox extends Migration {

  override name = 'Migration20261002013126_add_inbox_and_outbox';

  override up(): void | Promise<void> {
    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" varchar(255) not null,
        "message_id" varchar(255) not null,
        "payload_hash" varchar(255) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz null,
        primary key ("consumer_name", "message_id")
      );
    `);

    this.addSql(`
      create table "outbox_messages" (
        "id" uuid not null,
        "aggregate_id" uuid not null,
        "event_type" varchar(255) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" int not null default 0,
        "next_attempt_at" timestamptz null,
        "published_at" timestamptz null,
        primary key ("id")
      );
    `);

    this.addSql(`
      create index "outbox_pending_index"
      on "outbox_messages" ("published_at", "next_attempt_at");
    `);

    this.addSql(`
      alter table "outbox_messages"
      add constraint "outbox_attempts_non_negative"
      check (attempts >= 0);
    `);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
  }

}