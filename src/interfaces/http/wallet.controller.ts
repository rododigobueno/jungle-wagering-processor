import {
  Body,
  Controller,
  HttpCode,
  Post,
} from '@nestjs/common';

import { CreateWalletUseCase } from '../../application/wallet/create-wallet.use-case.js';

import type {
  CreateWalletInput,
  CreateWalletOutput,
} from '../../application/wallet/create-wallet.use-case.js';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() input: CreateWalletInput,
  ): Promise<CreateWalletOutput> {
    return this.createWalletUseCase.execute(input);
  }
}