import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { runWithWagerConcurrencyRetry } from './wager-concurrency-retry.js';
import { processWagerTransactionInTransaction } from './wager-transaction-processing.js';
import type {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput,
} from './wager-transaction-processing.js';

export { IdempotencyConflictError } from './wager-transaction-processing.js';
export type {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput,
} from './wager-transaction-processing.js';

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionOutput> {
    return runWithWagerConcurrencyRetry(this.em, (tx) =>
      processWagerTransactionInTransaction(tx, input),
    );
  }
}
