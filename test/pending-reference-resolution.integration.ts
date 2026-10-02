import { randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CreateWalletUseCase } from '../src/application/wallet/create-wallet.use-case.js';
import {
  MAX_REFERENCE_RESOLUTION_ATTEMPTS,
  ResolvePendingReferencesUseCase,
} from '../src/application/wagering/resolve-pending-references.use-case.js';
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
import { PendingReferenceResolverWorker } from '../src/infrastructure/wagering/pending-reference-resolver.worker.js';

const postgresBaseConfig = {
  host: 'localhost',
  port: 5432,
  user: 'jungle',
  password: 'jungle',
};

let orm: MikroORM;
let testDatabaseName = '';

beforeAll(async () => {
  testDatabaseName = `jungle_pending_ref_it_${randomUUID().replaceAll('-', '')}`;

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

describe('pending reference resolution with PostgreSQL', () => {
  it('processes a REFUND after its BET reference arrives later', async () => {
    const { walletId, playerId } = await createWallet('out-of-order');
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const roundId = `round-out-of-order-${randomUUID()}`;
    const betExternalId = `bet-late-${randomUUID()}`;

    const refund = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: `refund-early-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: betExternalId,
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

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

    const pendingEm = orm.em.fork();
    const pending = await pendingEm.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });
    pending.referenceNextAttemptAt = new Date(0);
    await pendingEm.flush();

    const resolver = new ResolvePendingReferencesUseCase(orm.em.fork());
    const result = await resolver.execute(1);

    expect(result).toEqual({ processed: 1, rejected: 0, rescheduled: 0 });

    const verifyEm = orm.em.fork({ clear: true });
    const storedRefund = await verifyEm.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });

    const wallet = await verifyEm.findOneOrFail(WalletEntity, { id: walletId });
    const refundCredits = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId,
      transactionId: refund.transactionId,
      direction: LedgerDirection.Credit,
    });

    expect(storedRefund.status).toBe(WagerTransactionStatus.Processed);
    expect(storedRefund.referenceTransactionId).toBe(bet.transactionId);
    expect(storedRefund.referenceRetryAttempts).toBe(0);
    expect(storedRefund.referenceNextAttemptAt).toBeNull();
    expect(wallet.balance).toBe('100.00');
    expect(refundCredits).toHaveLength(1);
  });

  it('reschedules when the reference is still missing', async () => {
    const { walletId, playerId } = await createWallet('reschedule');
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const refund = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId: `round-reschedule-${randomUUID()}`,
        externalTransactionId: `refund-reschedule-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: `missing-${randomUUID()}`,
      }),
    );

    const em = orm.em.fork();
    const pending = await em.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });
    pending.referenceNextAttemptAt = new Date(0);
    await em.flush();

    const before = new Date();
    const resolver = new ResolvePendingReferencesUseCase(orm.em.fork());
    const result = await resolver.execute(1);

    expect(result).toEqual({ processed: 0, rejected: 0, rescheduled: 1 });

    const verifyEm = orm.em.fork({ clear: true });
    const stored = await verifyEm.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });

    expect(stored.status).toBe(WagerTransactionStatus.PendingReference);
    expect(stored.referenceRetryAttempts).toBe(1);
    expect(stored.referenceNextAttemptAt).toBeInstanceOf(Date);
    expect(stored.referenceNextAttemptAt?.getTime()).toBeGreaterThan(
      before.getTime(),
    );
  });

  it('rejects after the bounded reference retry limit is exhausted', async () => {
    const { walletId, playerId } = await createWallet('exhausted');
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const refund = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId: `round-exhausted-${randomUUID()}`,
        externalTransactionId: `refund-exhausted-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: `missing-${randomUUID()}`,
      }),
    );

    const em = orm.em.fork();
    const pending = await em.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });
    pending.referenceRetryAttempts = MAX_REFERENCE_RESOLUTION_ATTEMPTS - 1;
    pending.referenceNextAttemptAt = new Date(0);
    await em.flush();

    const resolver = new ResolvePendingReferencesUseCase(orm.em.fork());
    const result = await resolver.execute(1);

    expect(result).toEqual({ processed: 0, rejected: 1, rescheduled: 0 });

    const verifyEm = orm.em.fork({ clear: true });
    const stored = await verifyEm.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });

    expect(stored.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(stored.referenceRetryAttempts).toBe(
      MAX_REFERENCE_RESOLUTION_ATTEMPTS,
    );
    expect(stored.referenceNextAttemptAt).toBeNull();
  });

  it('skips a pending row already locked by another resolver', async () => {
    const { walletId, playerId } = await createWallet('locked');
    const process = new ProcessWagerTransactionUseCase(orm.em.fork());
    const refund = await process.execute(
      wagerInput({
        walletId,
        playerId,
        roundId: `round-locked-${randomUUID()}`,
        externalTransactionId: `refund-locked-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: `missing-${randomUUID()}`,
      }),
    );

    const dueEm = orm.em.fork();
    const pending = await dueEm.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });
    pending.referenceNextAttemptAt = new Date(0);
    await dueEm.flush();

    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const lockAcquiredPromise = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const releaseLockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const lockEm = orm.em.fork();
    const holdLock = lockEm.transactional(async (tx) => {
      await tx.findOneOrFail(
        WagerTransactionEntity,
        { id: refund.transactionId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      lockAcquired();
      await releaseLockPromise;
    });

    await lockAcquiredPromise;

    const resolver = new ResolvePendingReferencesUseCase(orm.em.fork());
    const result = await resolver.execute(1);

    releaseLock();
    await holdLock;

    expect(result).toEqual({ processed: 0, rejected: 0, rescheduled: 0 });

    const verifyEm = orm.em.fork({ clear: true });
    const stored = await verifyEm.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });
    expect(stored.referenceRetryAttempts).toBe(0);
  });

  it('resolves a pending reference in the background worker', async () => {
    const { walletId, playerId } = await createWallet('worker');
    const processor = new ProcessWagerTransactionUseCase(orm.em.fork());
    const roundId = `round-worker-${randomUUID()}`;
    const betExternalId = `bet-worker-${randomUUID()}`;

    const refund = await processor.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: `refund-worker-${randomUUID()}`,
        kind: WagerTransactionKind.Refund,
        amount: '25.00',
        referenceExternalTransactionId: betExternalId,
      }),
    );

    await processor.execute(
      wagerInput({
        walletId,
        playerId,
        roundId,
        externalTransactionId: betExternalId,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      }),
    );

    const dueEm = orm.em.fork();
    const pending = await dueEm.findOneOrFail(WagerTransactionEntity, {
      id: refund.transactionId,
    });
    pending.referenceNextAttemptAt = new Date(0);
    await dueEm.flush();

    const previousEnabled = process.env.PENDING_REFERENCE_RESOLVER_ENABLED;
    process.env.PENDING_REFERENCE_RESOLVER_ENABLED = 'true';
    const worker = new PendingReferenceResolverWorker(orm.em.fork());

    try {
      worker.onApplicationBootstrap();
      await waitForResolved(refund.transactionId);
    } finally {
      await worker.onApplicationShutdown();
      if (previousEnabled === undefined) {
        delete process.env.PENDING_REFERENCE_RESOLVER_ENABLED;
      } else {
        process.env.PENDING_REFERENCE_RESOLVER_ENABLED = previousEnabled;
      }
    }

    const verifyEm = orm.em.fork({ clear: true });
    const wallet = await verifyEm.findOneOrFail(WalletEntity, { id: walletId });
    const credits = await verifyEm.find(WalletLedgerEntryEntity, {
      walletId,
      transactionId: refund.transactionId,
      direction: LedgerDirection.Credit,
    });

    expect(wallet.balance).toBe('100.00');
    expect(credits).toHaveLength(1);
  });
});

async function waitForResolved(transactionId: string): Promise<void> {
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    const em = orm.em.fork({ clear: true });
    const transaction = await em.findOne(WagerTransactionEntity, {
      id: transactionId,
    });

    if (transaction?.status === WagerTransactionStatus.Processed) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error('Pending reference worker did not resolve in time');
}

async function createWallet(label: string): Promise<{
  walletId: string;
  playerId: string;
}> {
  const playerId = `player-pending-${label}-${randomUUID()}`;
  const createWallet = new CreateWalletUseCase(orm.em.fork());
  const wallet = await createWallet.execute({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
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
    idempotencyKey: `idem-pending-${randomUUID()}`,
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
