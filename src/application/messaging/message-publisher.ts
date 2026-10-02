export interface PublishMessageInput {
  messageId: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}

export interface MessagePublisher {
  publish(input: PublishMessageInput): Promise<void>;
}
