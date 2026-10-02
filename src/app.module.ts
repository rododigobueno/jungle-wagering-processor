import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './mikro-orm.config.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

import { CreateWalletUseCase } from './application/wallet/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from './application/wagering/process-wager-transaction.use-case.js';

import { WalletController } from './interfaces/http/wallet.controller.js';
import { WageringController } from './interfaces/http/wagering.controller.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
  ],
  controllers: [
    AppController,
    WalletController,
    WageringController,
  ],
  providers: [
    AppService,
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
  ],
})
export class AppModule {}