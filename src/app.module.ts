import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './mikro-orm.config.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { CreateWalletUseCase } from './application/wallet/create-wallet.use-case.js';
import { WalletController } from './interfaces/http/wallet.controller.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
  ],
  controllers: [
    AppController,
    WalletController,
  ],
  providers: [
    AppService,
    CreateWalletUseCase,
  ],
})
export class AppModule {}