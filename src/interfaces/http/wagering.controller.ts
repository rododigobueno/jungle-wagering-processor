import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  Post,
} from '@nestjs/common';

import {
  IdempotencyConflictError,
  ProcessWagerTransactionUseCase,
} from '../../application/wagering/process-wager-transaction.use-case.js';

import type {
  ProcessWagerTransactionInput,
  ProcessWagerTransactionOutput,
} from '../../application/wagering/process-wager-transaction.use-case.js';

type SubmitWagerTransactionBody = Omit<
  ProcessWagerTransactionInput,
  'idempotencyKey'
>;

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    private readonly processWagerTransaction:
      ProcessWagerTransactionUseCase,
  ) {}

  @Post()
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: SubmitWagerTransactionBody,
  ): Promise<ProcessWagerTransactionOutput> {
    if (!idempotencyKey) {
      throw new BadRequestException(
        'Idempotency-Key header is required',
      );
    }

    try {
      return await this.processWagerTransaction.execute({
        ...body,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }
}