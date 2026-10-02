import { Money } from '../money/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateWalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(
    props: CreateWalletLedgerEntryProps,
  ): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!entry.hasConsistentCurrency()) {
      throw new Error('Ledger currencies must match');
    }

    if (!entry.isBalanced()) {
      throw new Error('Ledger entry is not balanced');
    }

    return entry;
  }

  static rehydrate(
    props: CreateWalletLedgerEntryProps,
  ): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
  }

  isBalanced(): boolean {
    const expectedBalance =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);

    return expectedBalance.equals(this.balanceAfter);
  }

  private hasConsistentCurrency(): boolean {
    return (
      this.money.currency === this.balanceBefore.currency &&
      this.money.currency === this.balanceAfter.currency
    );
  }
}