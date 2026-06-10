import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

// Controllers
import {
  MarketingAuthController,
  MarketingLeadsController,
  MarketingActivitiesController,
  MarketingTasksController,
  MarketingOffersController,
  MarketingDashboardController,
  MarketingReportsController,
  MarketingUsersController,
  MarketingCommissionsController,
  MarketingNotificationsController,
  MarketingLeadsIngestController,
  MarketingDistributionController,
} from './controllers';

// Services
import {
  MarketingAuthService,
  MarketingLeadsService,
  MarketingActivitiesService,
  MarketingTasksService,
  MarketingOffersService,
  MarketingDashboardService,
  MarketingReportsService,
  MarketingUsersService,
  MarketingCommissionsService,
  MarketingNotificationsService,
  MarketingSchedulerService,
  MarketingLeadsIngestService,
  LeadAutoAssignerService,
  MarketingDistributionService,
} from './services';

// Guards
import { MarketingGuard } from './guards/marketing.guard';
import { MarketingRolesGuard } from './guards/marketing-roles.guard';
import { IngestTokenGuard } from './guards/ingest-token.guard';
import { LeadQuotaResolver } from './services/lead-quota.resolver';
import { MarketingResearchService } from './services/marketing-research.service';
import { MarketingIngestTokensService } from './services/marketing-ingest-tokens.service';
import { MarketingResearchController } from './controllers/marketing-research.controller';

// Event consumers (Step C decoupling: settlement → commission crediting).
import { SettlementCommissionConsumer } from './events/settlement-commission.consumer';
import { HardwareQuoteConsumer } from './events/hardware-quote.consumer';

// Phase 2 telephony — single-line Netgsm sales calls (click-to-dial + manual log).
import { SalesCallController } from './controllers/sales-call.controller';
import { SalesCallService } from './services/sales-call.service';
import { TelephonyProviderRegistry } from './telephony/telephony-provider.registry';
import { NetgsmLiteAdapter } from './telephony/netgsm-lite.adapter';

// Phase 3 installation ops — crews, jobs, scheduling, tasks, ops dashboard.
import { InstallationController } from './installations/installation.controller';
import { InstallationJobService } from './installations/installation-job.service';
import { InstallationCrewService } from './installations/installation-crew.service';
import { InstallationConsumer } from './installations/installation.consumer';

// Phase 4 sales targets/quotas + performance-vs-target.
import { SalesTargetController } from './controllers/sales-target.controller';
import { SalesTargetService } from './services/sales-target.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('MARKETING_JWT_SECRET');
        const refresh = configService.get<string>('MARKETING_JWT_REFRESH_SECRET');
        const tenant = configService.get<string>('JWT_SECRET');
        const tenantRefresh = configService.get<string>('JWT_REFRESH_SECRET');
        const superadmin = configService.get<string>('SUPERADMIN_JWT_SECRET');
        if (!secret || !refresh) {
          throw new Error(
            'MARKETING_JWT_SECRET and MARKETING_JWT_REFRESH_SECRET must be configured',
          );
        }
        if (secret.length < 32 || refresh.length < 32) {
          throw new Error(
            'MARKETING_JWT_SECRET / MARKETING_JWT_REFRESH_SECRET must be at least 32 chars',
          );
        }
        const others = [tenant, tenantRefresh, superadmin].filter(Boolean);
        if (secret === refresh || others.includes(secret) || others.includes(refresh)) {
          throw new Error(
            'MARKETING_JWT_SECRET / REFRESH must differ from each other and from other realms',
          );
        }
        return {
          secret,
          signOptions: { expiresIn: '8h', algorithm: 'HS256' },
          verifyOptions: { algorithms: ['HS256'] },
        };
      },
    }),
  ],
  controllers: [
    // Listed first so /marketing/leads/ingest resolves to this controller's
    // literal route before Nest considers /:id on MarketingLeadsController.
    // (Nest matches literals before params regardless, but explicit
    // ordering avoids ambiguity for anyone reading the wiring.)
    MarketingLeadsIngestController,
    MarketingAuthController,
    MarketingLeadsController,
    MarketingActivitiesController,
    MarketingTasksController,
    MarketingOffersController,
    MarketingDashboardController,
    MarketingReportsController,
    MarketingUsersController,
    MarketingCommissionsController,
    MarketingNotificationsController,
    MarketingDistributionController,
    SalesCallController,
    InstallationController,
    SalesTargetController,
    MarketingResearchController,
  ],
  providers: [
    // Services
    MarketingAuthService,
    MarketingLeadsService,
    MarketingActivitiesService,
    MarketingTasksService,
    MarketingOffersService,
    MarketingDashboardService,
    MarketingReportsService,
    MarketingUsersService,
    MarketingCommissionsService,
    MarketingNotificationsService,
    MarketingLeadsIngestService,
    LeadAutoAssignerService,
    // Daily lead quota (Phase-F entitlement seam) — used by the ingest path.
    LeadQuotaResolver,
    // Research settings surface: profiles + per-workspace ingest tokens.
    MarketingResearchService,
    MarketingIngestTokensService,
    MarketingDistributionService,
    // Cron jobs (offer expiry, notification TTL, follow-up reminders).
    MarketingSchedulerService,
    // Event consumer: credits SIGNUP/RENEWAL/UPSELL commissions off
    // payment.succeeded.v1 (subscribes via DomainEventBus on init).
    SettlementCommissionConsumer,
    // Event consumer: creates + auto-assigns a HARDWARE_QUOTE lead off
    // marketing.lead.hardware_quote.v1 (emitted by the core catalog) — keeps
    // the lead write out of the core module for the Phase-5 split.
    HardwareQuoteConsumer,
    // Phase 2 telephony: sales-call log + single-line Netgsm provider.
    SalesCallService,
    TelephonyProviderRegistry,
    NetgsmLiteAdapter,
    // Phase 3 installation ops: crews, jobs, and the auto-create consumer
    // (reacts to marketing.lead.converted.v1).
    InstallationJobService,
    InstallationCrewService,
    InstallationConsumer,
    // Phase 4 sales targets/quotas + performance.
    SalesTargetService,
    // Guards
    MarketingGuard,
    MarketingRolesGuard,
    IngestTokenGuard,
  ],
  exports: [
    MarketingAuthService,
    MarketingUsersService,
    // InternalApiModule's research-jobs surface shares the quota-clipped
    // ingest path (one implementation of the clipping invariant).
    MarketingLeadsIngestService,
  ],
})
export class MarketingModule {}
