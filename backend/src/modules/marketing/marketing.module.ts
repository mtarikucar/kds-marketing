import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
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
import { MarketingBillingController } from './controllers/marketing-billing.controller';
import { FeatureGuard } from './guards/feature.guard';

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

// Phase F (GoHighLevel parity) — P1: AI core + the delayed-work primitive
// (ScheduledJob) that later phases (followups, campaign batches, booking
// reminders, workflow waits) all enqueue onto.
import { MarketingAiController } from './controllers/marketing-ai.controller';
import { ScheduledJobService } from './scheduling/scheduled-job.service';
import { ScheduledJobRunnerService } from './scheduling/scheduled-job-runner.service';
import { AnthropicService } from './ai/anthropic.service';
import { AiCreditsService } from './ai/ai-credits.service';
import { KnowledgeService } from './ai/knowledge.service';
import { AgentProfileService } from './ai/agent-profile.service';
import { ContentAiService } from './ai/content-ai.service';

// Phase F P2 — omnichannel conversations + web-chat + Conversation AI.
import { MarketingConversationsController } from './controllers/marketing-conversations.controller';
import { MarketingChannelsController } from './controllers/marketing-channels.controller';
import { WebchatPublicController } from './controllers/webchat-public.controller';
import { MetaWebhookController } from './controllers/meta-webhook.controller';
import { NetgsmPublicController } from './controllers/netgsm-public.controller';
import { SseTokenGuard } from './guards/sse-token.guard';
import { ChannelAdapterRegistry } from './channels/channel-adapter.registry';
import { MessageQuotaService } from './channels/message-quota.service';
import { ChannelsService } from './channels/channels.service';
import { ConversationsService } from './channels/conversations.service';
import { ConversationIngressService } from './channels/conversation-ingress.service';
import { ConversationStreamService } from './channels/conversation-stream.service';
import { MessageSenderService } from './channels/message-sender.service';
import { ConversationAiEngineService } from './channels/conversation-ai-engine.service';
import { PublicChannelResolverService } from './channels/public-channel-resolver.service';
import { WebchatAdapter } from './channels/adapters/webchat.adapter';
import { WhatsappCloudAdapter } from './channels/adapters/whatsapp-cloud.adapter';
import { NetgsmSmsAdapter } from './channels/adapters/netgsm-sms.adapter';
import { MessengerAdapter, InstagramAdapter } from './channels/adapters/meta-messaging.adapter';

// Phase F P3 — workflow automation (trigger → executor → action handlers).
import { MarketingWorkflowsController } from './controllers/marketing-workflows.controller';
import { WorkflowsService } from './workflows/workflows.service';
import { WorkflowActionHandler } from './workflows/workflow-action.handler';
import { WorkflowExecutorService } from './workflows/workflow-executor.service';
import { WorkflowTriggerService } from './workflows/workflow-trigger.service';

// Phase F P4 — campaigns (email/SMS/WhatsApp blasts) + tracking.
import { MarketingCampaignsController } from './controllers/marketing-campaigns.controller';
import { CampaignTrackingController } from './controllers/campaign-tracking.controller';
import { CampaignsService } from './campaigns/campaigns.service';
import { CampaignSenderService } from './campaigns/campaign-sender.service';
import { CampaignTrackingService } from './campaigns/campaign-tracking.service';

// Phase F P5 — funnels/sites + forms + booking.
import { MarketingSitesController } from './controllers/marketing-sites.controller';
import { MarketingBookingController } from './controllers/marketing-booking.controller';
import { PublicSiteController } from './controllers/public-site.controller';
import { SitesService } from './sites/sites.service';
import { SiteRendererService } from './sites/site-renderer.service';
import { FormsService } from './sites/forms.service';
import { BookingService } from './sites/booking.service';

@Module({
  imports: [
    // Entitlements (lead quota, seat/profile limits, feature gates) +
    // the billing services the workspace-facing controller mounts.
    BillingModule,
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
    MarketingBillingController,
    MarketingAiController,
    // Phase F P2 — inbox + channel config (workspace) and the public webhooks.
    MarketingConversationsController,
    MarketingChannelsController,
    WebchatPublicController,
    MetaWebhookController,
    NetgsmPublicController,
    MarketingWorkflowsController,
    MarketingCampaignsController,
    CampaignTrackingController,
    MarketingSitesController,
    MarketingBookingController,
    PublicSiteController,
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
    // Phase F P1 — delayed-work primitive: the enqueue/cancel service and the
    // once-a-minute claim+dispatch runner (advisory-locked, single-replica).
    // Feature modules register per-kind handlers in onModuleInit (P2+).
    ScheduledJobService,
    ScheduledJobRunnerService,
    // Phase F P1 — AI core: the single Anthropic entry point, monthly credit
    // metering, the knowledge base + agent profiles (Agent Studio), and
    // one-shot content generation.
    AnthropicService,
    AiCreditsService,
    KnowledgeService,
    AgentProfileService,
    ContentAiService,
    // Phase F P2 — omnichannel: adapter registry + adapters (self-register on
    // init), message quota, the conversation services, and the AI engine
    // (subscribes to inbound events + registers its ScheduledJob handlers).
    ChannelAdapterRegistry,
    WebchatAdapter,
    WhatsappCloudAdapter,
    NetgsmSmsAdapter,
    MessengerAdapter,
    InstagramAdapter,
    MessageQuotaService,
    ChannelsService,
    ConversationStreamService,
    MessageSenderService,
    ConversationIngressService,
    ConversationsService,
    ConversationAiEngineService,
    PublicChannelResolverService,
    SseTokenGuard,
    // Phase F P3 — workflow automation: the trigger listener + executor (each
    // registers its bus/ScheduledJob hooks on init) + action handler + CRUD.
    WorkflowsService,
    WorkflowActionHandler,
    WorkflowExecutorService,
    WorkflowTriggerService,
    // Phase F P4 — campaigns: CRUD/launch, the throttled batch sender (registers
    // the campaign.batch ScheduledJob handler), and public open/click/unsub.
    CampaignsService,
    CampaignSenderService,
    CampaignTrackingService,
    // Phase F P5 — funnels: page/form CRUD + AI draft, the safe block renderer,
    // public form submit, and booking (registers the booking.reminder handler).
    SitesService,
    SiteRendererService,
    FormsService,
    BookingService,
    // Guards
    MarketingGuard,
    MarketingRolesGuard,
    IngestTokenGuard,
    FeatureGuard,
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
