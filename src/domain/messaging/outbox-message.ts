export interface EnqueueOutboxProps {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}

export interface OutboxMessageState extends EnqueueOutboxProps {
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(props: EnqueueOutboxProps): OutboxMessage {
    return new OutboxMessage(
      props.id,
      props.aggregateId,
      props.eventType,
      props.payload,
      props.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) {
      return false;
    }

    return (
      this._nextAttemptAt === undefined ||
      this._nextAttemptAt.getTime() <= now.getTime()
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new Error('Outbox message already published');
    }

    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new Error('Published outbox message cannot be retried');
    }

    this._attempts += 1;

    const delayMs = 1000 * 2 ** (this._attempts - 1);

    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }
}