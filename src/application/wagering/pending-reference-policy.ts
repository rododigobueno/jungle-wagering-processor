export const MAX_REFERENCE_RESOLUTION_ATTEMPTS = 8;

const BASE_REFERENCE_RETRY_DELAY_MS = 1_000;
const MAX_REFERENCE_RETRY_DELAY_MS = 60_000;

export function getNextReferenceAttemptAt(
  now: Date,
  completedAttempts: number,
): Date {
  const delayMs = Math.min(
    BASE_REFERENCE_RETRY_DELAY_MS * 2 ** completedAttempts,
    MAX_REFERENCE_RETRY_DELAY_MS,
  );

  return new Date(now.getTime() + delayMs);
}
