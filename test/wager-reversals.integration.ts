import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CreateWalletUseCase } from '../src/application/wallet/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from '../src/application/wagering/process-wager-transaction.use-case.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/domain/wagering/wager-transaction.js';
import { LedgerDirection } from '../src/domain/ledger/wallet-ledger-entry.js';
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
  testDatabaseName = `jungle_reversal_it_${randomUUID().replaceAll('-', '')}`;

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

describe('wager reversals with PostgreSQL', () => {
  it('refunds a processed BET exactly once', async () => {
    const { walletId, playerId } = await createWallet('refund');
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const roundId = `round-refund-${randomUUID()}`;
    const betExternalId = `bet-${randomUUID()}`;

    const bet = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: betExternalId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.balance.amount).toBe('75.00');

    const refund = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: `refund-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: betExternalId,
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance.amount).toBe('100.00');

    const verifyEm = orm.em.fork({ clear: true });
    const refundEntity = await verifyEm.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });
    const refundCredits = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId,
      transactionId: refund.transactionId,
      direction: LedgerDirection.Credit,
    });

    expect(refundEntity.referenceTransactionId).toBe(bet.transactionId);
    expect(refundCredits).toHaveLength(1);
  });

  it('rolls back a processed WIN with the inverse ledger direction', async () => {
    const { walletId, playerId } = await createWallet('rollback-win');
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const roundId = `round-win-${randomUUID()}`;
    const winExternalId = `win-${randomUUID()}`;

    const win = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: winExternalId,
        kind: WagerTransactionKind.Win,
        amount: '20.00',
      }),
    );

    expect(win.balance.amount).toBe('120.00');

    const rollback = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: `rollback-${randomUUID()}`,
        kind: WagerTransactionKind.Rollback,
        amount: '20.00',
        referenceExternalTransactionId: winExternalId,
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance.amount).toBe('100.00');

    const verifyEm = orm.em.fork({ clear: true });
    const rollbackEntity = await verifyEm.findOneOrFail(
      WagerTransactionEntity,
      { id: rollback.transactionId },
    );
    const rollbackDebits = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId,
      transactionId: rollback.transactionId,
      direction: LedgerDirection.Debit,
    });

    expect(rollbackEntity.referenceTransactionId).toBe(win.transactionId);
    expect(rollbackDebits).toHaveLength(1);
  });

  it('keeps a reversal pending when the reference has not arrived yet', async () => {
    const { walletId, playerId } = await createWallet('pending-reference');
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const missingReference = `missing-bet-${randomUUID()}`;

    const refund = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId: `round-pending-${randomUUID()}`,
        externalTransactionId: `refund-pending-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: missingReference,
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.balance.amount).toBe('100.00');

    const verifyEm = orm.em.fork({ clear: true });
    const stored = await verifyEm.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });
    const ledger = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId,
      transactionId: refund.transactionId,
    });
    const pendingEvent = await verifyEm.find(OutboxMessageEntity, {
      aggregateId: refund.transactionId,
      eventType: 'WagerTransactionPendingReference',
    });

    expect(stored.referenceTransactionId).toBeNull();
    expect(ledger).toHaveLength(0);
    expect(pendingEvent).toHaveLength(1);
  });

  it('rejects a second REFUND of the same processed BET', async () => {
    const { walletId, playerId } = await createWallet('duplicate-refund');
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const roundId = `round-dup-${randomUUID()}`;
    const betExternalId = `bet-dup-${randomUUID()}`;

    await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: betExternalId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: `refund-a-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: betExternalId,
      }),
    );

    const secondRefund = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: `refund-b-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: betExternalId,
      }),
    );

    expect(secondRefund.status).toBe(WagerTransactionStatus.Rejected);
    expect(secondRefund.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(secondRefund.balance.amount).toBe('100.00');

    const verifyEm = orm.em.fork({ clear: true });
    const refundCredits = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId,
      direction: LedgerDirection.Credit,
    });

    // Opening credit + exactly one refund credit.
    expect(refundCredits).toHaveLength(2);
  });

  it('rejects a reversal with a different amount', async () => {
    const { walletId, playerId } = await createWallet('amount-mismatch');
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const roundId = `round-amount-${randomUUID()}`;
    const betExternalId = `bet-amount-${randomUUID()}`;

    await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: betExternalId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    const refund = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: `refund-amount-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '20.00',
        referenceExternalTransactionId: betExternalId,
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    expect(refund.balance.amount).toBe('75.00');
  });

  it('rejects a reversal outside the reference wallet/player scope', async () => {
    const original = await createWallet('scope-original');
    const other = await createWallet('scope-other');
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const roundId = `round-scope-${randomUUID()}`;
    const betExternalId = `bet-scope-${randomUUID()}`;

    await process.execute(
      wagerInput({
        walletId: original.walletId,
        playerId: original.playerId,
        roundId,
        externalTransactionId: betExternalId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    const refund = await process.execute(
      wagerInput({
        walletId: other.walletId,
        playerId: other.playerId,
        roundId,
        externalTransactionId: `refund-scope-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: betExternalId,
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe('REFERENCE_SCOPE_MISMATCH');
    expect(refund.balance.amount).toBe('100.00');
  });

  it('rejects a reversal whose reference is not processed yet', async () => {
    const { walletId, playerId } = await createWallet(
      'reference-not-processed',
    );
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const roundId = `round-pending-ref-${randomUUID()}`;
    const pendingExternalId = `refund-pending-ref-${randomUUID()}`;

    await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: pendingExternalId,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: `missing-${randomUUID()}`,
      }),
    );

    const rollback = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: `rollback-pending-ref-${randomUUID()}`,
        kind: WagerTransactionKind.Rollback,
        amount: '25.00',
        referenceExternalTransactionId: pendingExternalId,
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    expect(rollback.balance.amount).toBe('100.00');
  });

  it('rejects a rollback that would make the wallet negative', async () => {
    const { walletId, playerId } = await createWallet(
      'negative-rollback',
      '0.00',
    );
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const winRoundId = `round-negative-win-${randomUUID()}`;
    const winExternalId = `win-negative-${randomUUID()}`;

    await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId: winRoundId,
        externalTransactionId: winExternalId,
        kind: WagerTransactionKind.Win,
        amount: '20.00',
      }),
    );

    await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId: `round-spend-${randomUUID()}`,
        externalTransactionId: `bet-spend-${randomUUID()}`,
        kind: WagerTransactionKind.Bet,
        amount: '20.00',
      }),
    );

    const rollback = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId: winRoundId,
        externalTransactionId: `rollback-negative-${randomUUID()}`,
        kind: WagerTransactionKind.Rollback,
        amount: '20.00',
        referenceExternalTransactionId: winExternalId,
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe('REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE');
    expect(rollback.balance.amount).toBe('0.00');
  });

  it('processes only one of two concurrent REFUNDs for the same BET', async () => {
    const { walletId, playerId } = await createWallet('concurrent-refund');
    const setup = new ProcessWagerTransactionUseCase(orm.em.fork());
    const roundId = `round-concurrent-refund-${randomUUID()}`;
    const betExternalId = `bet-concurrent-refund-${randomUUID()}`;

    await setup.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: betExternalId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    const processA = new ProcessWagerTransactionUseCase(orm.em.fork());
    const processB = new ProcessWagerTransactionUseCase(orm.em.fork());
    const refundInput = () =>
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: `refund-concurrent-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: betExternalId,
      });

    const [a, b] = await Promise.all([
      processA.execute(refundInput()),
      processB.execute(refundInput()),
    ]);

    const results = [a, b];
    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.failureCode === 'REFERENCE_ALREADY_REVERSED',
      ),
    ).toHaveLength(1);

    const verifyEm = orm.em.fork({ clear: true });
    const wallet = await verifyEm.findOneOrFail(WalletEntity, { id: walletId });
    const credits = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId,
      direction: LedgerDirection.Credit,
    });
    expect(wallet.balance).toBe('100.00');
    expect(credits).toHaveLength(2);
  });
});

async function createWallet(
  label: string,
  initialBalance = '100.00',
): Promise<{
  walletId: string;
  playerId: string;
}> {
  const playerId = `player-${label}-${randomUUID()}`;
  const createWallet = new CreateWalletUseCase(orm.em.fork());
  const wallet = await createWallet.execute({
    playerId,
    initialBalance: { amount: initialBalance, currency: 'BRL' },
  });

  return { walletId: wallet.id, playerId };
}

interface WagerInputOptions {
  walletId: string;
  playerId: string;
  roundId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  amount: string;
  referenceExternalTransactionId?: string;
}

function wagerInput(options: WagerInputOptions) {
  return {
    idempotencyKey: `idem-${randomUUID()}`,
    providerId: 'integration-provider',
    externalTransactionId: options.externalTransactionId,
    walletId: options.walletId,
    playerId: options.playerId,
    roundId: options.roundId,
    gameId: 'integration-game',
    kind: options.kind,
    money: { amount: options.amount, currency: 'BRL' },
    referenceExternalTransactionId: options.referenceExternalTransactionId,
  };
}
