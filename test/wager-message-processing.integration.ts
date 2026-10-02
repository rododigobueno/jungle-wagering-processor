import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  InboxPayloadConflictError,
  ProcessWagerMessageUseCase,
} from '../src/application/wagering/process-wager-message.use-case.js';
import { CreateWalletUseCase } from '../src/application/wallet/create-wallet.use-case.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/domain/wagering/wager-transaction.js';
import { LedgerDirection } from '../src/domain/ledger/wallet-ledger-entry.js';
import { InboxMessageEntity } from '../src/infrastructure/database/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../src/infrastructure/database/entities/outbox-message.entity.js';
import { WagerTransactionEntity } from '../src/infrastructure/database/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/infrastructure/database/entities/wallet-ledger-entry.entity.js';
import { WalletEntity } from '../src/infrastructure/database/entities/wallet.entity.js';

const postgresBaseConfig = {
  host: 'localhost',
  port: 5432,
  user: 'jungle',
  password: 'jungle',
};

let orm: MikroORM;
let testDatabaseName = '';

beforeAll(async () => {
  testDatabaseName = `jungle_inbox_it_${randomUUID().replaceAll('-', '')}`;

  const adminOrm = await MikroORM.init({
    ...postgresBaseConfig,
    dbName: 'postgres',
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });

  await adminOrm.schema.createDatabase(testDatabaseName);
  await adminOrm.close(true);

  orm = await MikroORM.init({
    ...postgresBaseConfig,
    dbName: testDatabaseName,
    entities: [
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
    ],
  });

  await orm.schema.create();
});

afterAll(async () => {
  await orm.close(true);

  const adminOrm = await MikroORM.init({
    ...postgresBaseConfig,
    dbName: 'postgres',
    entities: [],
    discovery: { warnWhenNoEntities: false },
  });

  await adminOrm.schema.dropDatabase(testDatabaseName);
  await adminOrm.close(true);
});

describe('ProcessWagerMessageUseCase integration', () => {
  it('processes one message atomically and ignores its redelivery', async () => {
    const createWallet = new CreateWalletUseCase(orm.em.fork());
    const wallet = await createWallet.execute({
      playerId: `player-inbox-${randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const baselineOutboxCount = await orm.em
      .fork()
      .count(OutboxMessageEntity, {});

    const message = {
      messageId: `message-${randomUUID()}`,
      transaction: {
        idempotencyKey: `idem-${randomUUID()}`,
        providerId: 'integration-provider',
        externalTransactionId: `ext-${randomUUID()}`,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: `round-${randomUUID()}`,
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      },
    };

    const processor = new ProcessWagerMessageUseCase(orm.em.fork());

    const first = await processor.execute(message);
    const second = await processor.execute(message);

    expect(first.inboxReplay).toBe(false);
    expect(first.transaction?.status).toBe(WagerTransactionStatus.Processed);
    expect(first.transaction?.balance.amount).toBe('20.00');
    expect(second).toEqual({ inboxReplay: true });

    const verifyEm = orm.em.fork({ clear: true });
    const inbox = await verifyEm.find(InboxMessageEntity, {
      consumerName: 'wager-transactions-consumer',
      messageId: message.messageId,
    });
    const storedWallet = await verifyEm.findOneOrFail(WalletEntity, {
      id: wallet.id,
    });
    const debits = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: LedgerDirection.Debit,
    });
    const bets = await verifyEm.find(WagerTransactionEntity, {
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
    });
    const outboxCount = await verifyEm.count(OutboxMessageEntity, {});

    expect(inbox).toHaveLength(1);
    expect(inbox[0].processedAt).toBeInstanceOf(Date);
    expect(storedWallet.balance).toBe('20.00');
    expect(debits).toHaveLength(1);
    expect(bets).toHaveLength(1);
    expect(outboxCount).toBe(baselineOutboxCount + 2);
  });

  it('rolls back Inbox when financial processing fails', async () => {
    const messageId = `message-${randomUUID()}`;
    const processor = new ProcessWagerMessageUseCase(orm.em.fork());

    await expect(
      processor.execute({
        messageId,
        transaction: {
          idempotencyKey: `idem-${randomUUID()}`,
          providerId: 'integration-provider',
          externalTransactionId: `ext-${randomUUID()}`,
          walletId: randomUUID(),
          playerId: `missing-player-${randomUUID()}`,
          roundId: `round-${randomUUID()}`,
          gameId: 'integration-game',
          kind: WagerTransactionKind.Bet,
          money: { amount: '10.00', currency: 'BRL' },
        },
      }),
    ).rejects.toThrow('Wallet not found');

    const verifyEm = orm.em.fork({ clear: true });
    const inbox = await verifyEm.find(InboxMessageEntity, {
      consumerName: 'wager-transactions-consumer',
      messageId,
    });

    expect(inbox).toHaveLength(0);
  });

  it('deduplicates two concurrent deliveries of the same message', async () => {
    const createWallet = new CreateWalletUseCase(orm.em.fork());
    const wallet = await createWallet.execute({
      playerId: `player-inbox-race-${randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const message = {
      messageId: `message-race-${randomUUID()}`,
      transaction: {
        idempotencyKey: `idem-race-${randomUUID()}`,
        providerId: 'integration-provider',
        externalTransactionId: `ext-race-${randomUUID()}`,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: `round-race-${randomUUID()}`,
        gameId: 'integration-game',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      },
    };

    const processorA = new ProcessWagerMessageUseCase(orm.em.fork());
    const processorB = new ProcessWagerMessageUseCase(orm.em.fork());

    const [resultA, resultB] = await Promise.all([
      processorA.execute(message),
      processorB.execute(message),
    ]);

    const results = [resultA, resultB];
    expect(results.filter((result) => result.inboxReplay)).toHaveLength(1);
    expect(results.filter((result) => !result.inboxReplay)).toHaveLength(1);

    const verifyEm = orm.em.fork({ clear: true });
    const inbox = await verifyEm.find(InboxMessageEntity, {
      consumerName: 'wager-transactions-consumer',
      messageId: message.messageId,
    });
    const walletEntity = await verifyEm.findOneOrFail(WalletEntity, {
      id: wallet.id,
    });
    const debits = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: LedgerDirection.Debit,
    });
    const bets = await verifyEm.find(WagerTransactionEntity, {
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
    });

    expect(inbox).toHaveLength(1);
    expect(inbox[0].processedAt).toBeInstanceOf(Date);
    expect(walletEntity.balance).toBe('20.00');
    expect(debits).toHaveLength(1);
    expect(bets).toHaveLength(1);
  });

  it('rejects reuse of a message ID with a different payload', async () => {
    const createWallet = new CreateWalletUseCase(orm.em.fork());
    const wallet = await createWallet.execute({
      playerId: `player-inbox-conflict-${randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const processor = new ProcessWagerMessageUseCase(orm.em.fork());
    const messageId = `message-conflict-${randomUUID()}`;
    const transaction = {
      idempotencyKey: `idem-conflict-${randomUUID()}`,
      providerId: 'integration-provider',
      externalTransactionId: `ext-conflict-${randomUUID()}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: `round-conflict-${randomUUID()}`,
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    };

    await processor.execute({ messageId, transaction });

    await expect(
      processor.execute({
        messageId,
        transaction: {
          ...transaction,
          money: { amount: '20.00', currency: 'BRL' },
        },
      }),
    ).rejects.toBeInstanceOf(InboxPayloadConflictError);

    const verifyEm = orm.em.fork({ clear: true });
    const storedWallet = await verifyEm.findOneOrFail(WalletEntity, {
      id: wallet.id,
    });
    const debits = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: LedgerDirection.Debit,
    });

    expect(storedWallet.balance).toBe('90.00');
    expect(debits).toHaveLength(1);
  });
});
