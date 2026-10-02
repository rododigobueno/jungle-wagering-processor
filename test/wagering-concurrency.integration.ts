import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';

import { CreateWalletUseCase } from '../src/application/wallet/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../src/application/wagering/process-wager-transaction.use-case.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/domain/wagering/wager-transaction.js';
import { LedgerDirection } from '../src/domain/ledger/wallet-ledger-entry.js';
import { WalletEntity } from '../src/infrastructure/database/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../src/infrastructure/database/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../src/infrastructure/database/entities/wallet-ledger-entry.entity.js';
import { OutboxMessageEntity } from '../src/infrastructure/database/entities/outbox-message.entity.js';

const postgresBaseConfig = {
  host: 'localhost',
  port: 5432,
  user: 'jungle',
  password: 'jungle',
};

let orm: MikroORM;
let testDatabaseName: string;
beforeAll(async () => {
  testDatabaseName = `jungle_wagering_it_${randomUUID().replaceAll('-', '')}`;

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

describe('wagering concurrency with PostgreSQL', () => {
  it('processes exactly one of two concurrent BETs when funds cover only one', async () => {
    const createWallet = new CreateWalletUseCase(orm.em.fork());
    const wallet = await createWallet.execute({
      playerId: `player-concurrency-${randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const baseInput = {
      providerId: 'integration-provider',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: `round-${randomUUID()}`,
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    };
    const processorA = new ProcessWagerTransactionUseCase(orm.em.fork());
    const processorB = new ProcessWagerTransactionUseCase(orm.em.fork());

    const [resultA, resultB] = await Promise.all([
      processorA.execute({
        ...baseInput,
        idempotencyKey: `idem-a-${randomUUID()}`,
        externalTransactionId: `ext-a-${randomUUID()}`,
      }),
      processorB.execute({
        ...baseInput,
        idempotencyKey: `idem-b-${randomUUID()}`,
        externalTransactionId: `ext-b-${randomUUID()}`,
      }),
    ]);

    const results = [resultA, resultB];
    const processed = results.filter(
      (result) => result.status === WagerTransactionStatus.Processed,
    );
    const rejected = results.filter(
      (result) => result.status === WagerTransactionStatus.Rejected,
    );

    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(processed[0].balance.amount).toBe('20.00');
    expect(rejected[0].balance.amount).toBe('20.00');
    const verifyEm = orm.em.fork({ clear: true });
    const walletEntity = await verifyEm.findOneOrFail(WalletEntity, {
      id: wallet.id,
    });

    expect(walletEntity.balance).toBe('20.00');
    expect(walletEntity.version).toBe(2);

    const ledgerEntries = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
    });
    const debits = ledgerEntries.filter(
      (entry) => entry.direction === LedgerDirection.Debit,
    );

    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe('80.00');
    expect(debits[0].balanceBefore).toBe('100.00');
    expect(debits[0].balanceAfter).toBe('20.00');

    const bets = await verifyEm.find(WagerTransactionEntity, {
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
    });

    expect(bets).toHaveLength(2);
    expect(
      bets.filter((bet) => bet.status === WagerTransactionStatus.Processed),
    ).toHaveLength(1);
    expect(
      bets.filter((bet) => bet.status === WagerTransactionStatus.Rejected),
    ).toHaveLength(1);
  });

  it('replays one of two concurrent identical requests', async () => {
    const createWallet = new CreateWalletUseCase(orm.em.fork());
    const wallet = await createWallet.execute({
      playerId: `player-idempotency-${randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const input = {
      idempotencyKey: `idem-shared-${randomUUID()}`,
      providerId: 'integration-provider',
      externalTransactionId: `ext-shared-${randomUUID()}`,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: `round-${randomUUID()}`,
      gameId: 'integration-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    };

    const processorA = new ProcessWagerTransactionUseCase(orm.em.fork());
    const processorB = new ProcessWagerTransactionUseCase(orm.em.fork());
    const [resultA, resultB] = await Promise.all([
      processorA.execute(input),
      processorB.execute(input),
    ]);

    expect(resultA.status).toBe(WagerTransactionStatus.Processed);
    expect(resultB.status).toBe(WagerTransactionStatus.Processed);
    expect(resultA.transactionId).toBe(resultB.transactionId);
    expect(
      [resultA, resultB].filter((result) => result.idempotentReplay),
    ).toHaveLength(1);
    expect(resultA.balance.amount).toBe('20.00');
    expect(resultB.balance.amount).toBe('20.00');

    const verifyEm = orm.em.fork({ clear: true });
    const walletEntity = await verifyEm.findOneOrFail(WalletEntity, {
      id: wallet.id,
    });
    expect(walletEntity.balance).toBe('20.00');
    expect(walletEntity.version).toBe(2);

    const bets = await verifyEm.find(WagerTransactionEntity, {
      walletId: wallet.id,
      kind: WagerTransactionKind.Bet,
    });
    expect(bets).toHaveLength(1);

    const ledgerEntries = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: LedgerDirection.Debit,
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].amount).toBe('80.00');
  });
});
