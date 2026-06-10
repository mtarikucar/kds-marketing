import { Module } from '@nestjs/common';
import { InternalTokenGuard } from './internal-token.guard';
import { ResearchTokenGuard } from './research-token.guard';
import { InternalReferralController } from './internal-referral.controller';
import { InternalEventsController } from './internal-events.controller';
import { InternalResearchController } from './internal-research.controller';
import { MarketingModule } from '../marketing/marketing.module';

/**
 * Service-to-service surface of the marketing service (Phase-5 split):
 *
 *   POST /api/internal/referral/resolve — core resolves a referral code
 *     (server side of ReferralDirectoryPort; marketing owns the impl).
 *   POST /api/internal/events — core delivers business events
 *     (payment.succeeded.v1) onto this service's outbox → DomainEventBus.
 *
 * Both endpoints are guarded by the shared INTERNAL_SERVICE_TOKEN
 * (x-internal-token header). ReferralDirectoryService is provided by the
 * @Global ProvisioningClientModule; OutboxService by the @Global OutboxModule.
 */
@Module({
  imports: [MarketingModule],
  controllers: [
    InternalReferralController,
    InternalEventsController,
    InternalResearchController,
  ],
  providers: [InternalTokenGuard, ResearchTokenGuard],
})
export class InternalApiModule {}
