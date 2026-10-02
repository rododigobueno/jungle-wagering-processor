import {
  OptimisticLockError,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';

const MAX_CONCURRENCY_RETRIES = 5;

const RETRYABLE_TRANSACTION_UNIQUE_CONSTRAINTS = new Set([
  'wager_transaction_idempotency_key_unique',
  'wager_transaction_provider_external_unique',
  'wager_transaction_processed_reversal_unique',
]);

export interface WagerConcurrencyRetryOptions {
  additionalRetryableError?: (error: unknown) => boolean;
}

export async function runWithWagerConcurrencyRetry<T>(
  em: EntityManager,
  work: (tx: EntityManager) => Promise<T>,
  options: WagerConcurrencyRetryOptions = {},
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_CONCURRENCY_RETRIES; attempt++) {
    const fork = em.fork();

    try {
      return await fork.transactional(work);
    } catch (error) {
      const canRetry =
        attempt < MAX_CONCURRENCY_RETRIES &&
        (error instanceof OptimisticLockError ||
          isRetryableTransactionUniqueConstraint(error) ||
          options.additionalRetryableError?.(error) === true);

      if (!canRetry) {
        throw error;
      }

      await waitBeforeRetry(attempt);
    }
  }

  throw new Error('Concurrency retry limit exhausted');
}

function isRetryableTransactionUniqueConstraint(error: unknown): boolean {
  const constraint = getUniqueConstraintName(error);

  return (
    constraint !== undefined &&
    RETRYABLE_TRANSACTION_UNIQUE_CONSTRAINTS.has(constraint)
  );
}

export function getUniqueConstraintName(error: unknown): string | undefined {
  if (!(error instanceof UniqueConstraintViolationException)) {
    return undefined;
  }

  const constraint = (
    error as UniqueConstraintViolationException & {
      constraint?: unknown;
    }
  ).constraint;

  return typeof constraint === 'string' ? constraint : undefined;
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMs = 10 * 2 ** (attempt - 1);

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
