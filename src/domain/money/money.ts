import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const amount = props.amount.trim();
    const currency = props.currency.trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error('Invalid currency');
    }

    if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) {
      throw new Error('Invalid monetary amount');
    }

    const value = new Decimal(amount);

    if (!value.isFinite() || value.isNegative()) {
      throw new Error('Invalid monetary amount');
    }

    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    const normalizedCurrency = currency.trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      throw new Error('Invalid currency');
    }

    return new Money(new Decimal(0), normalizedCurrency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.add(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.sub(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.value.equals(other.value)
    );
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.currency} ${this.value.toFixed(2)}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} !== ${other.currency}`,
      );
    }
  }
}