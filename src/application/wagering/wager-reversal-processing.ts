import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';

import { LedgerDirection } from '../../domain/ledger/wallet-ledger-entry.js';
import { Money } from '../../domain/money/money.js';
import { Wallet } from '../../domain/wallet/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction.js';
import { WagerTransactionEntity } from '../../infrastructure/database/entities/wager-transaction.entity.js';

interface ApplyReversalOptions {
  tx: EntityManager;
  transaction: WagerTransaction;
  wallet: Wallet;
  money: Money;
  now: Date;
}

export async function applyWagerReversal(
  options: ApplyReversalOptions,
): Promise<LedgerDirection | undefined> {
  const { tx, transaction, wallet, money, now } = options;
  const referenceExternalId = transaction.referenceExternalTransactionId;

  if (!referenceExternalId) {
    throw new Error('Reversal reference is required');
  }

  const reference = await tx.findOne(
    WagerTransactionEntity,
    {
      providerId: transaction.providerId,
      externalTransactionId: referenceExternalId,
    },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  );

  if (!reference) {
    transaction.markPendingReference();
    return undefined;
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    transaction.reject('REFERENCE_NOT_PROCESSED');
    return undefined;
  }

  if (!isReferenceTypeAllowed(transaction.kind, reference.kind)) {
    transaction.reject('INVALID_REFERENCE_TYPE');
    return undefined;
  }

  if (!hasMatchingScope(transaction, money, reference)) {
    transaction.reject('REFERENCE_SCOPE_MISMATCH');
    return undefined;
  }

  const referenceMoney = Money.from({
    amount: reference.amount,
    currency: reference.currency,
  });

  if (!referenceMoney.equals(money)) {
    transaction.reject('REFERENCE_AMOUNT_MISMATCH');
    return undefined;
  }

  const existingReversal = await tx.findOne(WagerTransactionEntity, {
    referenceTransactionId: reference.id,
    kind: transaction.kind,
    status: WagerTransactionStatus.Processed,
  });

  if (existingReversal) {
    transaction.reject('REFERENCE_ALREADY_REVERSED');
    return undefined;
  }

  const ledgerDirection = applyReversalBalance(
    transaction,
    reference.kind,
    wallet,
    money,
  );

  if (transaction.status === WagerTransactionStatus.Rejected) {
    return undefined;
  }

  transaction.markProcessed(reference.id, now);
  return ledgerDirection;
}

function isReferenceTypeAllowed(
  kind: WagerTransactionKind,
  referenceKind: string,
): boolean {
  if (kind === WagerTransactionKind.Refund) {
    return referenceKind === WagerTransactionKind.Bet;
  }

  return (
    referenceKind === WagerTransactionKind.Bet ||
    referenceKind === WagerTransactionKind.Win ||
    referenceKind === WagerTransactionKind.Refund
  );
}

function hasMatchingScope(
  transaction: WagerTransaction,
  money: Money,
  reference: WagerTransactionEntity,
): boolean {
  return (
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.currency === money.currency &&
    reference.roundId === transaction.roundId
  );
}

function applyReversalBalance(
  transaction: WagerTransaction,
  referenceKind: string,
  wallet: Wallet,
  money: Money,
): LedgerDirection {
  if (
    transaction.kind === WagerTransactionKind.Refund ||
    referenceKind === WagerTransactionKind.Bet
  ) {
    wallet.credit(money);
    return LedgerDirection.Credit;
  }

  try {
    wallet.debit(money);
    return LedgerDirection.Debit;
  } catch (error) {
    if (error instanceof Error && error.message === 'Insufficient funds') {
      transaction.reject('REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE');
      return LedgerDirection.Debit;
    }

    throw error;
  }
}
