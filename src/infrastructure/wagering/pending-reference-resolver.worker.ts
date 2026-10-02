import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { ResolvePendingReferencesUseCase } from '../../application/wagering/resolve-pending-references.use-case.js';

@Injectable()
export class PendingReferenceResolverWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PendingReferenceResolverWorker.name);
  private resolver?: ResolvePendingReferencesUseCase;
  private running = false;
  private loopPromise?: Promise<void>;

  constructor(private readonly em: EntityManager) {}

  onApplicationBootstrap(): void {
    if (process.env.PENDING_REFERENCE_RESOLVER_ENABLED !== 'true') {
      return;
    }

    this.resolver = new ResolvePendingReferencesUseCase(this.em);
    this.running = true;
    this.loopPromise = this.runLoop();

    void this.loopPromise.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Pending reference resolver stopped: ${message}`);
    });

    this.logger.log('Pending reference resolver started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;

    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }
  }

  private async runLoop(): Promise<void> {
    if (!this.resolver) {
      return;
    }

    while (this.running) {
      try {
        const result = await this.resolver.execute(10);
        const handled = result.processed + result.rejected + result.rescheduled;

        if (handled === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch (error) {
        if (!this.running) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Pending reference resolution failed: ${message}`);

        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
}
