import { Money } from '../money/money.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
         if (props.initialBalance.isNegative()) {
      throw new Error('Initial balance cannot be negative');
    }

    const now = new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money): void {
    this.assertSameCurrency(money);
    this.assertNonNegativeMovement(money);

    if (money.isZero()) {
      return;
    }

    if (this._balance.isLessThan(money)) {
      throw new Error('Insufficient funds');
    }

    this._balance = this._balance.subtract(money);
    this.incrementVersion();
  }

  credit(money: Money): void {
    this.assertSameCurrency(money);
    this.assertNonNegativeMovement(money);

    if (money.isZero()) {
      return;
    }

    this._balance = this._balance.add(money);
    this.incrementVersion();
  }

  private incrementVersion(): void {
    this._version += 1;
    this._updatedAt = new Date();
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} !== ${money.currency}`,
      );
    }
  }

  private assertNonNegativeMovement(money: Money): void {
    if (money.isNegative()) {
      throw new Error('Movement amount cannot be negative');
    }
  }
}