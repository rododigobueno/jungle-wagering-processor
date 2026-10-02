import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/mikro-orm.config.ts';

const portA = Number(process.env.DISTRIBUTED_PORT_A ?? '3111');
const portB = Number(process.env.DISTRIBUTED_PORT_B ?? '3112');
const dbName = `jungle_distributed_${randomUUID().replaceAll('-', '')}`;

interface RunningInstance {
  process: ChildProcess;
  logs: string[];
}

const instances: RunningInstance[] = [];
let adminOrm: MikroORM | undefined;
let testOrm: MikroORM | undefined;

try {
  adminOrm = await MikroORM.init({
    ...config,
    dbName: 'postgres',
    entities: [],
    entitiesTs: [],
    discovery: { warnWhenNoEntities: false },
  });

  await adminOrm.schema.createDatabase(dbName);

  testOrm = await MikroORM.init({ ...config, dbName });
  await testOrm.schema.create();
  await testOrm.close(true);
  testOrm = undefined;

  const instanceA = startInstance(portA);
  const instanceB = startInstance(portB);
  instances.push(instanceA, instanceB);

  await Promise.all([waitForHealth(portA), waitForHealth(portB)]);

  const playerId = `player-distributed-${randomUUID()}`;
  const walletResponse = await fetch(`http://localhost:${portA}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  });

  if (!walletResponse.ok) {
    throw new Error(`Wallet creation failed: ${walletResponse.status}`);
  }

  const wallet = (await walletResponse.json()) as {
    id: string;
    playerId: string;
  };

  const roundId = `round-distributed-${randomUUID()}`;
  const [resultA, resultB] = await Promise.all([
    sendBet(portA, wallet.id, wallet.playerId, roundId, 'a'),
    sendBet(portB, wallet.id, wallet.playerId, roundId, 'b'),
  ]);

  const results = [resultA, resultB];
  const processed = results.filter(
    (result) => result.body.status === 'PROCESSED',
  );
  const rejected = results.filter(
    (result) =>
      result.body.status === 'REJECTED' &&
      result.body.failureCode === 'INSUFFICIENT_FUNDS',
  );

  if (processed.length !== 1 || rejected.length !== 1) {
    throw new Error(
      `Unexpected distributed result: ${JSON.stringify(results)}`,
    );
  }

  if (results.some((result) => result.status !== 201)) {
    throw new Error(`Unexpected HTTP status: ${JSON.stringify(results)}`);
  }

  if (results.some((result) => result.body.balance.amount !== '20.00')) {
    throw new Error(`Unexpected response balance: ${JSON.stringify(results)}`);
  }

  testOrm = await MikroORM.init({ ...config, dbName });
  const connection = testOrm.em.getConnection();

  const walletRows = await connection.execute(
    'select balance, version from wallets where id = ?',
    [wallet.id],
  );
  const debitRows = await connection.execute(
    `select count(*)::int as count
     from wallet_ledger_entries
     where wallet_id = ? and direction = 'DEBIT'`,
    [wallet.id],
  );
  const betRows = await connection.execute(
    `select status, failure_code
     from wager_transactions
     where wallet_id = ? and kind = 'BET'
     order by created_at`,
    [wallet.id],
  );

  if (walletRows[0]?.balance !== '20.00' || walletRows[0]?.version !== 2) {
    throw new Error(`Unexpected wallet state: ${JSON.stringify(walletRows)}`);
  }

  if (Number(debitRows[0]?.count) !== 1 || betRows.length !== 2) {
    throw new Error(
      `Unexpected persistence state: ${JSON.stringify({ debitRows, betRows })}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        result: 'DISTRIBUTED_CONCURRENCY_OK',
        walletId: wallet.id,
        responses: results,
        persistedBalance: walletRows[0]?.balance,
        debitCount: Number(debitRows[0]?.count),
      },
      null,
      2,
    ),
  );
} finally {
  for (const instance of instances) {
    await stopInstance(instance);
  }

  if (testOrm) {
    await testOrm.close(true);
  }

  if (adminOrm) {
    await adminOrm.schema.dropDatabase(dbName);
    await adminOrm.close(true);
  }
}

function startInstance(port: number): RunningInstance {
  const logs: string[] = [];
  const child = spawn('node', ['dist/main'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DB_NAME: dbName,
      PENDING_REFERENCE_RESOLVER_ENABLED: 'false',
      SQS_WAGER_CONSUMER_ENABLED: 'false',
      SQS_OUTBOX_DISPATCHER_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk) => {
    logs.push(String(chunk));
  });
  child.stderr?.on('data', (chunk) => {
    logs.push(String(chunk));
  });

  return { process: child, logs };
}

interface BetResult {
  status: number;
  body: {
    status: string;
    balance: { amount: string; currency: string };
    failureCode?: string;
  };
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.ok) return;
    } catch {
      // The process can still be starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Application on port ${port} did not become ready`);
}

async function sendBet(
  port: number,
  walletId: string,
  playerId: string,
  roundId: string,
  label: string,
): Promise<BetResult> {
  const response = await fetch(
    `http://localhost:${port}/wagering/transactions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': `idem-${label}-${randomUUID()}`,
      },
      body: JSON.stringify({
        providerId: 'distributed-test',
        externalTransactionId: `ext-${label}-${randomUUID()}`,
        walletId,
        playerId,
        roundId,
        gameId: 'distributed-game',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      }),
    },
  );

  return {
    status: response.status,
    body: (await response.json()) as BetResult['body'],
  };
}

async function stopInstance(instance: RunningInstance): Promise<void> {
  if (instance.process.exitCode !== null) {
    return;
  }

  instance.process.kill();

  await Promise.race([
    new Promise<void>((resolve) => {
      instance.process.once('exit', () => resolve());
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);

  if (instance.process.exitCode === null) {
    instance.process.kill('SIGKILL');
  }
}
