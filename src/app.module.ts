import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import mikroOrmConfig from './mikro-orm.config.js';

import { CreateWalletUseCase } from './application/wallet/create-wallet.use-case.js';
import { ProcessWagerTransactionUseCase } from './application/wagering/process-wager-transaction.use-case.js';
import { SqsOutboxDispatcherWorker } from './infrastructure/messaging/sqs-outbox-dispatcher.worker.js';
import { SqsWagerConsumerWorker } from './infrastructure/messaging/sqs-wager-consumer.worker.js';
import { PendingReferenceResolverWorker } from './infrastructure/wagering/pending-reference-resolver.worker.js';

import { HealthController } from './interfaces/http/health.controller.js';
import { WalletController } from './interfaces/http/wallet.controller.js';
import { WageringController } from './interfaces/http/wagering.controller.js';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [HealthController, WalletController, WageringController],
  providers: [
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    PendingReferenceResolverWorker,
    SqsOutboxDispatcherWorker,
    SqsWagerConsumerWorker,
  ],
})
export class AppModule {}
