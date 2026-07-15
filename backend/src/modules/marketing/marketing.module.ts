import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { NetgsmModule } from '../netgsm/netgsm.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

// Controllers
import {
  MarketingAuthController,
  MarketingLeadsController,
  MarketingActivitiesController,
  MarketingTasksController,
  MarketingCustomFieldsController,
  MarketingTagsController,
  MarketingSegmentsController,
  MarketingImportsController,
  MarketingApiKeysController,
  MarketingWebhooksController,
  PublicApiV1Controller,
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
  CustomFieldsService,
  TagsService,
  SegmentCompilerService,
  SegmentsService,
  LeadDedupeService,
  ImportService,
  ApiKeysService,
  WebhookOutboundService,
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
// Multi-workspace membership — authz resolution reads (Phase 1 Task 2).
import { MembershipService } from './services/membership.service';
// Multi-workspace membership — the logged-in accept-invite route (Phase 2 Task 12).
import { MarketingMembershipsController } from './controllers/marketing-memberships.controller';
import { MarketingResearchService } from './services/marketing-research.service';
import { MarketingIngestTokensService } from './services/marketing-ingest-tokens.service';
import { MarketingResearchController } from './controllers/marketing-research.controller';
import { MarketingBillingController } from './controllers/marketing-billing.controller';
import { FeatureGuard } from './guards/feature.guard';

// Event consumers (Step C decoupling: settlement → commission crediting).
import { SettlementCommissionConsumer } from './events/settlement-commission.consumer';
import { MetaCapiConsumer } from './events/meta-capi.consumer';
import { HardwareQuoteConsumer } from './events/hardware-quote.consumer';

// Phase 2 telephony — single-line Netgsm sales calls (click-to-dial + manual log).
import { SalesCallController } from './controllers/sales-call.controller';
import { SalesCallService } from './services/sales-call.service';
import { DialerController } from './controllers/dialer.controller';
import { DialerService } from './services/dialer.service';
// NetGSM Phase 5 Task 5 — parallel power-dialer ("parallel mode"), the
// autocallservice-backed counterpart to DialerService's preview queue.
import { AutocallDialerController } from './controllers/autocall-dialer.controller';
import { AutocallDialerService } from './services/autocall-dialer.service';
import { AutocallReportConsumer } from './campaigns/autocall-report.consumer';
import { TelephonyProviderRegistry } from './telephony/telephony-provider.registry';
import { NetgsmLiteAdapter } from './telephony/netgsm-lite.adapter';
import { NetgsmApiAdapter } from './telephony/netgsm-api.adapter';
import { TelephonyConfigService } from './telephony/telephony-config.service';
import { CallCdrSyncService } from './telephony/call-cdr-sync.service';
// NetGSM Phase 4 Task 2 — proxy-download call recordings into R2 (stable
// storage, independent of the provider tokenized URL's longevity) + a daily
// retention sweep that reclaims storage past the workspace's configured
// recordingRetentionDays.
import { RecordingIngestService } from './telephony/recording-ingest.service';
import { RecordingRetentionService } from './telephony/recording-retention.service';
// NetGSM Phase 3 Task 2 — telephony event consumer (subscribes
// marketing.telephony.call_event.v1: INBOUND/missed SalesCalls + crm_id
// correlation for OUTBOUND hangup/cdr).
import { TelephonyEventConsumer } from './telephony/telephony-event.consumer';
// NetGSM Phase 3 Task 3 — per-workspace SSE fan-out for screen-pop/call-status.
import { TelephonyStreamService } from './telephony/telephony-stream.service';
import { TelephonyConfigController, WebphoneConfigController } from './controllers/telephony-config.controller';
import { TelephonyStreamController } from './controllers/telephony-stream.controller';
// NetGSM Phase 3 Task 5 — in-call control (hangup/transfer/mute) over the
// LIVE netsantral call, keyed by SalesCall.externalCallId.
import { TelephonyControlController } from './controllers/telephony-control.controller';
import { TelephonyControlService } from './services/telephony-control.service';
// NetGSM Phase 4 Task 4 — queue wallboard (queuestats) + agent presence
// (agentlogin/agentlogoff/agentpause), acting on the CALLING rep's own dahili.
import { TelephonyQueueController } from './controllers/telephony-queue.controller';
import { TelephonyQueueService } from './services/telephony-queue.service';
import { TelephonyReportsController } from './controllers/telephony-reports.controller';
import { TelephonyReportsService } from './services/telephony-reports.service';
// NetGSM Phase 5 Task 6 — "leave your number, we call you now" callback
// (dynamic_redirect); İYS ARAMA consent + brandcode is mandatory, fail-closed.
import { TelephonyCallbackController } from './controllers/telephony-callback.controller';
import { TelephonyCallbackService } from './services/telephony-callback.service';
import { NetgsmOnboardingController } from './controllers/netgsm-onboarding.controller';
import { NetgsmOnboardingService } from './services/netgsm-onboarding.service';

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
import { AskAiService } from './ai/ask-ai.service';

// Phase F P2 — omnichannel conversations + web-chat + Conversation AI.
import { MarketingConversationsController } from './controllers/marketing-conversations.controller';
import { MarketingChannelsController } from './controllers/marketing-channels.controller';
import { WebchatPublicController } from './controllers/webchat-public.controller';
import { MetaWebhookController } from './controllers/meta-webhook.controller';
import { NetgsmPublicController } from './controllers/netgsm-public.controller';
import { RecordingProxyController } from './controllers/recording-proxy.controller';
import { SseTokenGuard } from './guards/sse-token.guard';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ChannelAdapterRegistry } from './channels/channel-adapter.registry';
import { MessageQuotaService } from './channels/message-quota.service';
import { ChannelsService } from './channels/channels.service';
import { ConversationsService } from './channels/conversations.service';
import { ConversationIngressService } from './channels/conversation-ingress.service';
import { MetaLeadgenIngestService } from './channels/meta-leadgen-ingest.service';
import { ConversationStreamService } from './channels/conversation-stream.service';
import { MessageSenderService } from './channels/message-sender.service';
import { MessageReceiptService } from './channels/message-receipt.service';
import { ConversationAiEngineService } from './channels/conversation-ai-engine.service';
import { PublicChannelResolverService } from './channels/public-channel-resolver.service';
import { NetgsmReportClient } from './channels/netgsm-report.client';
import { NetgsmDlrPollService } from './channels/netgsm-dlr-poll.service';
import { NetgsmBlacklistSyncService } from './channels/netgsm-blacklist-sync.service';
import { NetgsmMoPollService } from './channels/netgsm-mo-poll.service';
import { NetgsmVoicemailPollService } from './channels/netgsm-voicemail-poll.service';
import { NetgsmFaxPollService } from './channels/netgsm-fax-poll.service';
import { WebchatAdapter } from './channels/adapters/webchat.adapter';
import { WhatsappCloudAdapter } from './channels/adapters/whatsapp-cloud.adapter';
import { NetgsmSmsAdapter } from './channels/adapters/netgsm-sms.adapter';
import { MessengerAdapter, InstagramAdapter } from './channels/adapters/meta-messaging.adapter';
import { TiktokDmAdapter } from './channels/adapters/tiktok-dm.adapter';
import { LinkedinEngagementAdapter } from './channels/adapters/linkedin-engagement.adapter';
import { LinkedinEngagementPollService } from './channels/linkedin-engagement-poll.service';
import { TiktokWebhookController } from './controllers/tiktok-webhook.controller';
import { EmailChannelAdapter } from './channels/adapters/email.adapter';
import { EmailWebhookController } from './controllers/email-webhook.controller';

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
import { CampaignSmsStatsService } from './campaigns/campaign-sms-stats.service';
// NetGSM Phase 5 Task 3 — voice-campaign report webhook consumer: writes
// CampaignRecipient voiceState/pushButton/talkSec + press-1 keypress trigger.
import { VoiceReportConsumer } from './campaigns/voice-report.consumer';
// NetGSM Phase 5 Task 4 — POST /campaigns/voice/audio (.wav → audioid).
import { VoiceAudioUploadService } from './campaigns/voice-audio-upload.service';
// NetGSM Phase 6 Task 1 — POST /fax/send (PDF → NetGSM fax job), the
// send-fax action surfaced on the lead/conversation views.
import { FaxController } from './controllers/fax.controller';
import { FaxSendService } from './campaigns/fax-send.service';

// Phase F P5 — funnels/sites + forms + booking.
import { MarketingSitesController } from './controllers/marketing-sites.controller';
import { MarketingBookingController } from './controllers/marketing-booking.controller';
import { PublicSiteController } from './controllers/public-site.controller';
import { SitesService } from './sites/sites.service';
import { SiteRendererService } from './sites/site-renderer.service';
import { FormsService } from './sites/forms.service';
import { LeadAttributionService } from './leads/lead-attribution.service';
import { ChannelTariffService } from './wallet/channel-tariff.service';
import { SpendLedgerService } from './wallet/spend-ledger.service';
import { GrowthWalletService } from './wallet/growth-wallet.service';
import { AdSpendMirrorService } from './budget/ad-spend-mirror.service';
import { BudgetAnomalyService } from './budget/budget-anomaly.service';
import { BudgetQuickstartService } from './budget/budget-quickstart.service';
import { BudgetActivityService } from './budget/budget-activity.service';
import { SocialPostMetricService } from './social-planner/social-post-metric.service';
import { BudgetPerformanceSource } from './budget/budget-performance.source';
import { BudgetAutopilotService } from './budget/budget-autopilot.service';
import { BudgetExecutorService } from './budget/budget-executor.service';
import { BudgetManagementService } from './budget/budget-management.service';
import { ConversationSpendService } from './budget/conversation-spend.service';
import { ResearchSpendService } from './budget/research-spend.service';
import { FirecrawlProvider } from './research/providers/firecrawl.provider';
import { ApifyProvider } from './research/providers/apify.provider';
import { ResearchSourcesService } from './research/providers/research-sources.service';
import { ResearchJobService } from './research/research-job.service';
import { ResearchCandidateService } from './research/research-candidate.service';
import { ResearchWorkerService } from './research/research-worker.service';
import { ResearchRunnerService } from './research/research-runner.service';
import { BudgetPacerService } from './budget/budget-pacer.service';
import { BudgetAutopilotCron } from './budget/budget-autopilot.cron';
import { PerformanceLoopService } from './budget/performance-loop.service';
import { AgentRunService } from './agents/agent-run.service';
import { BrandBrainService } from './brand-brain/brand-brain.service';
import { TrendRemixService } from './trends/trend-remix.service';
import { VideoPipelineService } from './video/video-pipeline.service';
import { McpToolRegistry } from './mcp/mcp-tool-registry';
import { McpBrokerService } from './mcp/mcp-broker.service';
import { AdWriteCapabilityService } from './ads/ad-write-capability.service';
import { VideoPersonaService } from './video/video-persona.service';
import { UnifiedCalendarService } from './trends/unified-calendar.service';
import { ApprovalRequestService } from './agents/approval-request.service';
import { MarketingApprovalsController } from './controllers/marketing-approvals.controller';
import { MarketingPersonasController } from './controllers/marketing-personas.controller';
import { MarketingTrendsController } from './controllers/marketing-trends.controller';
import { MarketingContentCalendarController } from './controllers/marketing-content-calendar.controller';
import { MarketingBrandBrainController } from './controllers/marketing-brand-brain.controller';
import { MarketingBudgetController } from './controllers/marketing-budget.controller';
import { BookingService } from './sites/booking.service';

// Phase F P6 — reviews / reputation.
import { MarketingReviewsController } from './controllers/marketing-reviews.controller';
import { ReviewGateController } from './controllers/review-gate.controller';
import { ReviewsService } from './reviews/reviews.service';
import { ReviewSyncService } from './reviews/review-sync.service';
// Review-source OAuth connect (A9) — inert until provider creds + secret-box.
import { ReviewOAuthService } from './reviews/review-oauth.service';
import { PublicReviewOAuthController } from './controllers/public-review-oauth.controller';
// Epic 13 — prospecting audit (inert until PAGESPEED_API_KEY).
import { AuditService } from './prospecting/audit.service';
import { ProspectingController } from './controllers/prospecting.controller';
import { PublicAuditController } from './controllers/public-audit.controller';
// Epic 13 — sending domains / DKIM (inert until SENDING_DOMAIN_ESP).
import { SendingDomainsService } from './sending-domains/sending-domains.service';
import { SendingDomainsController } from './controllers/sending-domains.controller';
// Epic 13 — custom-domain white-label (inert until CUSTOM_DOMAINS_ENABLED).
import { CustomDomainsService } from './custom-domains/custom-domains.service';
import { CustomDomainsController } from './controllers/custom-domains.controller';
import { PublicCustomDomainController } from './controllers/public-custom-domain.controller';
// List-hygiene write side — ESP bounce/complaint suppression (inert w/o ESP_FEEDBACK_SECRET).
import { EspFeedbackService } from './channels/esp-feedback.service';
import { EspFeedbackController } from './controllers/esp-feedback.controller';
// Affiliate referral loop — public /r/:slug redirect + attribution + self-signup.
import { PublicReferralController } from './controllers/public-referral.controller';

// Phase F P8 — Voice AI (Twilio).
import { MarketingVoiceController } from './controllers/marketing-voice.controller';
import { TwilioVoiceController } from './controllers/twilio-voice.controller';
import { VoiceAdapter } from './channels/adapters/voice.adapter';
import { VoiceAiService } from './channels/voice-ai.service';
// Voice AI (NetGSM) — STT, post-call analysis, custom-LLM bridge, NetGSM IVR, copilot.
import { SttService } from './voice-ai/stt.service';
import { CallAnalysisService } from './voice-ai/call-analysis.service';
import { CallAnalysisCron } from './voice-ai/call-analysis.cron';
import { VoiceAiBridgeService } from './voice-ai/voice-ai-bridge.service';
import { VoiceAiBridgeController } from './voice-ai/voice-ai-bridge.controller';
import { NetgsmIvrService } from './voice-ai/netgsm-ivr.service';
import { NetgsmIvrController } from './voice-ai/netgsm-ivr.controller';
import { CopilotService } from './voice-ai/copilot.service';
import { CopilotController } from './voice-ai/copilot.controller';
import { VoiceAiStatusController } from './voice-ai/voice-ai-status.controller';
// Phase F P8 — configurable IVR / phone-tree menus over the Voice flow.
import { IvrController } from './ivr/ivr.controller';
import { IvrService } from './ivr/ivr.service';

// Phase F P9 — end-customer invoicing.
import { MarketingInvoicesController } from './controllers/marketing-invoices.controller';
import { PublicInvoiceController } from './controllers/public-invoice.controller';
import { InvoicesService } from './invoicing/invoices.service';
import { InvoiceTextService } from './invoicing/invoice-text.service';

// Phase F P10 — white-label-lite branding.
import { MarketingBrandingController } from './controllers/marketing-branding.controller';
import { PublicBrandingController } from './controllers/public-branding.controller';
import { BrandingService } from './branding/branding.service';

// GHL parity — affiliate manager (affiliates, referrals, commissions, payouts).
import { AffiliateController } from './controllers/affiliate.controller';
import { AffiliateService } from './services/affiliate.service';
import { PublicAffiliatePortalController } from './controllers/public-affiliate-portal.controller';
import { AffiliatePortalGuard } from './guards/affiliate-portal.guard';

// Epic D1 (GHL parity) — agency / sub-account hierarchy (agency owns location
// workspaces; scoped cross-into-child management behind assertAgencyOwns).
import { AgencyController } from './controllers/agency.controller';
import { AgencyService } from './services/agency.service';
// Epic D1 (GHL parity) — agency config snapshots (capture workspace config,
// clone into child locations behind assertAgencyOwns).
import { SnapshotController } from './controllers/snapshot.controller';
import { SnapshotService } from './services/snapshot.service';
// Epic D1 (GHL parity) — agency rebilling / SaaS-mode (per-location SaaS plans,
// REAL usage metering, env-gated Stripe-Connect settlement behind assertAgencyOwns).
import { RebillingController } from './controllers/rebilling.controller';
import { RebillingService } from './services/rebilling.service';

// P11 (GoHighLevel parity): env-gated social media planner (schedule + multi-network publish).
import { SocialPlannerController } from './social-planner/social-planner.controller';
import { SocialPlannerService } from './social-planner/social-planner.service';
import { R2StorageService } from '../../common/storage/r2-storage.service';
import { MarketingMediaController } from './controllers/marketing-media.controller';
import { MarketingMediaWebhookController } from './controllers/marketing-media-webhook.controller';
import { MediaGenService } from './ai/media/media-gen.service';
import { BrandKitService } from './ai/media/brand-kit.service';
import { FalProvider } from './ai/providers/fal.provider';
import { MEDIA_PROVIDER } from './ai/providers/media-provider.interface';
import { SocialCampaignsController } from './social-campaigns/social-campaigns.controller';
import { SocialCampaignsService } from './social-campaigns/social-campaigns.service';
import { SocialCampaignLinkService } from './social-campaigns/social-campaign-link.service';
import { SocialOAuthController } from './social-planner/oauth/social-oauth.controller';
import { SocialOAuthService } from './social-planner/oauth/social-oauth.service';
import { AccountCenterController } from './account-center/account-center.controller';
import { AccountCenterService } from './account-center/account-center.service';
import { SocialTokenRefreshService } from './social-planner/oauth/social-token-refresh.service';

// Epic C — memberships: courses/modules/lessons + enrollment/progress.
import { CoursesController } from './memberships/courses.controller';
import { CoursesService } from './memberships/courses.service';
import { EnrollmentController } from './memberships/enrollment.controller';
import { EnrollmentService } from './memberships/enrollment.service';
import { CertificateService } from './memberships/certificate.service';
import { PublicCertificateController } from './controllers/public-certificate.controller';
import { GamificationService } from './memberships/gamification.service';
// Epic G — analytics (read-only lead aggregations).
import { AnalyticsController } from './analytics/analytics.controller';
import { AnalyticsService } from './analytics/analytics.service';
import { AttributionService } from './analytics/attribution.service';
// Epic F (compliance) — GDPR/KVKK consent log + data subject requests.
import { ComplianceController } from './compliance/compliance.controller';
import { ComplianceService } from './compliance/compliance.service';
// NetGSM Phase 2 Task 3 — İYS auto-push (consent writes -> İYS proof queue).
import { IysSyncService } from './compliance/iys-sync.service';
// NetGSM Phase 2 Task 4 — İYS push-back webhook consumer (applies
// İYS-originated ONAY/RET onto the matching lead's MARKETING_SMS consent).
import { IysWebhookConsumer } from './compliance/iys-webhook.consumer';
// Epic E — funnel A/B experiments + surveys.
// Epic F — 2FA/MFA (TOTP + NetGSM SMS v2 Task 12's SMS factor).
import { TwoFactorController } from './controllers/two-factor.controller';
import { TwoFactorService } from './services/two-factor.service';
// NetGSM SMS v2 Task 12 — shared OTP issue/verify (2FA-SMS + lead phone verify).
import { SmsOtpService } from './services/sms-otp.service';
// Epic B4 — Slack incoming-webhook notifications.
import { SlackController } from './integrations/slack.controller';
import { SlackService } from './integrations/slack.service';
// Epic G — env-gated enterprise SSO (OIDC, authorization-code + PKCE).
import {
  SsoAdminController,
  SsoPublicController,
} from './integrations/sso.controller';
import { SsoService } from './services/sso.service';
// Integrations — env-gated Google Calendar 2-way sync (OAuth, push + pull).
import {
  GoogleCalendarController,
  GoogleCalendarPublicController,
} from './integrations/google-calendar.controller';
import { GoogleCalendarService } from './integrations/google-calendar.service';
import { GoogleCalendarSyncService } from './integrations/google-calendar-sync.service';
import { HostResolverService } from './integrations/conferencing/host-resolver.service';
import { GoogleMeetSpacesService } from './integrations/conferencing/google-meet-spaces.service';
import {
  OutlookCalendarController,
  OutlookCalendarPublicController,
} from './integrations/outlook-calendar.controller';
import { OutlookCalendarService } from './integrations/outlook-calendar.service';
import { OutlookCalendarSyncService } from './integrations/outlook-calendar-sync.service';
// Epic F — custom roles + granular permissions.
import { RolesController } from './roles/roles.controller';
import { RolesService } from './roles/roles.service';
import { PermissionsGuard } from './roles/permissions.guard';

// Sales Opportunities + Pipelines (GoHighLevel parity).
import { MarketingOpportunitiesController } from './controllers/marketing-opportunities.controller';
import { PipelinesService } from './opportunities/pipelines.service';
import { OpportunitiesService } from './opportunities/opportunities.service';

// Products catalog (GoHighLevel parity).
import { MarketingProductsController } from './controllers/marketing-products.controller';
import { ProductsService } from './products/products.service';

// Estimates / quotes (GoHighLevel parity).
import { MarketingEstimatesController } from './controllers/marketing-estimates.controller';
import { PublicEstimateController } from './controllers/public-estimate.controller';
import { EstimatesService } from './estimates/estimates.service';

// Recurring customer subscriptions (GoHighLevel parity).
import { MarketingSubscriptionsController } from './controllers/marketing-subscriptions.controller';
import { SubscriptionsService } from './subscriptions/subscriptions.service';
import { SubscriptionsSchedulerService } from './subscriptions/subscriptions-scheduler.service';

// E-signature documents / contracts (GoHighLevel parity).
import { MarketingDocumentsController } from './controllers/marketing-documents.controller';
import { PublicDocumentController } from './controllers/public-document.controller';
import { DocumentsService } from './documents/documents.service';

// Public payment-enabled order forms (GoHighLevel parity).
import { MarketingOrderFormsController } from './controllers/marketing-order-forms.controller';
import { PublicOrderFormController } from './controllers/public-order-form.controller';
import { OrderFormsService } from './order-forms/order-forms.service';

// Ad reporting — Meta Ads + TikTok Ads + LinkedIn Ads (GoHighLevel parity).
import { MarketingAdsController } from './controllers/marketing-ads.controller';
import { MarketingAdRulesController } from './controllers/marketing-ad-rules.controller';
import { AdAccountService } from './ads/ad-account.service';
import { AdsPullService } from './ads/ads-pull.service';
import { LinkedinAdsOAuthController } from './ads/linkedin-ads-oauth.controller';
import { LinkedinAdsOAuthService } from './ads/linkedin-ads-oauth.service';
import { GoogleAdsOAuthController } from './ads/google-ads-oauth.controller';
import { GoogleAdsOAuthService } from './ads/google-ads-oauth.service';
// TikTok-for-Business OAuth (ads module — NOT social-planner)
import { TiktokBusinessOAuthController } from './ads/tiktok-business-oauth.controller';
import { TiktokBusinessOAuthService } from './ads/tiktok-business-oauth.service';
import { AdManagementService } from './ads/ad-management.service';
import { AudienceSyncService } from './ads/audience-sync.service';
import { AdRulesService } from './ads/ad-rules.service';

// Custom Objects (GoHighLevel parity) — workspace-defined record types.

// Inbox productivity (GoHighLevel parity) — snippets, notes, bulk, export.
import { MarketingSnippetsController } from './controllers/marketing-snippets.controller';
import { SnippetsService } from './inbox/snippets.service';
import { LeadBulkService } from './inbox/lead-bulk.service';

// Trigger links + QR codes (GoHighLevel parity).
import { MarketingTriggerLinksController } from './controllers/marketing-trigger-links.controller';
import { PublicTriggerLinkController } from './controllers/public-trigger-link.controller';
import { TriggerLinksService } from './trigger-links/trigger-links.service';
import { MarketingInboundWebhooksController } from './controllers/marketing-inbound-webhooks.controller';
import { PublicInboundWebhookController } from './controllers/public-inbound-webhook.controller';
import { InboundWebhooksService } from './inbound-webhooks/inbound-webhooks.service';
import { InboundWebhookGuard } from './guards/inbound-webhook.guard';
import { MarketingCompaniesController } from './controllers/marketing-companies.controller';
import { CompaniesService } from './companies/companies.service';
import { MarketingFunnelsController } from './controllers/marketing-funnels.controller';
import { PublicFunnelController } from './controllers/public-funnel.controller';
import { PageFunnelsService } from './page-funnels/page-funnels.service';
import { MarketingEmailTemplatesController } from './controllers/marketing-email-templates.controller';
import { EmailTemplatesService } from './email-templates/email-templates.service';
import { EmailHygieneService } from './leads/email-hygiene.service';

// Tax rates (GoHighLevel parity) — KDV/VAT on invoices + estimates.
import { MarketingTaxRatesController } from './controllers/marketing-tax-rates.controller';
import { TaxRatesService } from './tax-rates/tax-rates.service';

// Coupons (GoHighLevel parity) — discount codes on order forms + invoices.
import { MarketingCouponsController } from './controllers/marketing-coupons.controller';
import { CouponsService } from './coupons/coupons.service';

// Customer store-credit wallet (GoHighLevel parity).
import { MarketingWalletController } from './controllers/marketing-wallet.controller';
import { WalletService } from './wallet/wallet.service';

@Module({
  imports: [
    // Entitlements (lead quota, seat/profile limits, feature gates) +
    // the billing services the workspace-facing controller mounts.
    BillingModule,
    NetgsmModule,
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
    MarketingCustomFieldsController,
    MarketingTagsController,
    MarketingSegmentsController,
    MarketingImportsController,
    MarketingApiKeysController,
    MarketingWebhooksController,
    PublicApiV1Controller,
    MarketingOffersController,
    MarketingDashboardController,
    MarketingReportsController,
    MarketingUsersController,
    MarketingCommissionsController,
    MarketingNotificationsController,
    MarketingDistributionController,
    // Multi-workspace membership — logged-in accept-invite (Phase 2 Task 12).
    MarketingMembershipsController,
    SalesCallController,
    DialerController,
    AutocallDialerController,
    TelephonyConfigController,
    WebphoneConfigController,
    TelephonyStreamController,
    TelephonyControlController,
    TelephonyQueueController,
    TelephonyCallbackController,
    TelephonyReportsController,
    NetgsmOnboardingController,
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
    TiktokWebhookController,
    EmailWebhookController,
    NetgsmPublicController,
    RecordingProxyController,
    MarketingWorkflowsController,
    MarketingCampaignsController,
    CampaignTrackingController,
    FaxController,
    MarketingSitesController,
    MarketingBookingController,
    PublicSiteController,
    MarketingOpportunitiesController,
    MarketingProductsController,
    MarketingEstimatesController,
    PublicEstimateController,
    MarketingSubscriptionsController,
    MarketingDocumentsController,
    PublicDocumentController,
    PublicCertificateController,
    ProspectingController,
    PublicAuditController,
    SendingDomainsController,
    CustomDomainsController,
    PublicCustomDomainController,
    EspFeedbackController,
    PublicReferralController,
    PublicReviewOAuthController,
    MarketingOrderFormsController,
    PublicOrderFormController,
    MarketingAdsController,
    TiktokBusinessOAuthController,
    MarketingAdRulesController,
    MarketingBudgetController,
    MarketingApprovalsController,
    MarketingPersonasController,
    MarketingTrendsController,
    MarketingContentCalendarController,
    MarketingBrandBrainController,
    MarketingSnippetsController,
    MarketingTriggerLinksController,
    PublicTriggerLinkController,
    MarketingInboundWebhooksController,
    PublicInboundWebhookController,
    MarketingCompaniesController,
    MarketingFunnelsController,
    PublicFunnelController,
    MarketingEmailTemplatesController,
    MarketingTaxRatesController,
    MarketingCouponsController,
    MarketingWalletController,
    MarketingReviewsController,
    ReviewGateController,
    MarketingVoiceController,
    TwilioVoiceController,
    IvrController,
    VoiceAiBridgeController,
    NetgsmIvrController,
    CopilotController,
    VoiceAiStatusController,
    MarketingInvoicesController,
    PublicInvoiceController,
    MarketingBrandingController,
    PublicBrandingController,
    CoursesController,
    EnrollmentController,
    AnalyticsController,
    ComplianceController,
    TwoFactorController,
    SlackController,
    RolesController,
    SsoAdminController,
    SsoPublicController,
    GoogleCalendarController,
    GoogleCalendarPublicController,
    OutlookCalendarController,
    OutlookCalendarPublicController,
    AffiliateController,
    PublicAffiliatePortalController,
    AgencyController,
    SnapshotController,
    RebillingController,
    SocialPlannerController,
    SocialOAuthController,
    AccountCenterController,
    MarketingMediaController,
    MarketingMediaWebhookController,
    SocialCampaignsController,
    LinkedinAdsOAuthController,
    GoogleAdsOAuthController,
  ],
  providers: [
    // Services
    MarketingAuthService,
    MarketingLeadsService,
    MarketingActivitiesService,
    MarketingTasksService,
    CustomFieldsService,
    TagsService,
    SegmentCompilerService,
    SegmentsService,
    LeadDedupeService,
    ImportService,
    ApiKeysService,
    WebhookOutboundService,
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
    // Multi-workspace membership — authz-resolution reads (Phase 1 Task 2);
    // consumed by the guard (Task 3) and auth service (Tasks 4-7).
    MembershipService,
    // Research settings surface: profiles + per-workspace ingest tokens.
    MarketingResearchService,
    MarketingIngestTokensService,
    MarketingDistributionService,
    // Cron jobs (offer expiry, notification TTL, follow-up reminders).
    MarketingSchedulerService,
    // Event consumer: credits SIGNUP/RENEWAL/UPSELL commissions off
    // payment.succeeded.v1 (subscribes via DomainEventBus on init).
    SettlementCommissionConsumer,
    MetaCapiConsumer,
    // Event consumer: creates + auto-assigns a HARDWARE_QUOTE lead off
    // marketing.lead.hardware_quote.v1 (emitted by the core catalog) — keeps
    // the lead write out of the core module for the Phase-5 split.
    HardwareQuoteConsumer,
    // Phase 2 telephony: sales-call log + single-line Netgsm provider.
    SalesCallService,
    DialerService,
    // NetGSM Phase 5 Task 5 — parallel power-dialer service (registers the
    // autocall.stream ScheduledJob handler on init) + its attempt-webhook
    // consumer (registers its bus subscription on init).
    AutocallDialerService,
    AutocallReportConsumer,
    TelephonyProviderRegistry,
    NetgsmLiteAdapter,
    NetgsmApiAdapter,
    TelephonyConfigService,
    CallCdrSyncService,
    // NetGSM Phase 4 Task 2 — recording ingest (→ R2) + retention sweeps.
    RecordingIngestService,
    RecordingRetentionService,
    // NetGSM Phase 3 Task 5 — in-call control (hangup/transfer/mute).
    TelephonyControlService,
    // NetGSM Phase 4 Task 4 — queue wallboard + agent presence.
    TelephonyQueueService,
    // NetGSM Phase 4 Task 5 — inbound call statistics dashboard.
    TelephonyReportsService,
    // NetGSM Phase 5 Task 6 — "call this number back now" (dynamic_redirect).
    TelephonyCallbackService,
    // NetGSM Phase 3 Task 2 — subscribes via DomainEventBus on init.
    TelephonyEventConsumer,
    // NetGSM Phase 3 Task 3 — per-workspace SSE fan-out (screen-pop, live
    // call status), pushed to by TelephonyEventConsumer, read by
    // TelephonyStreamController's GET /marketing/telephony/stream.
    TelephonyStreamService,
    NetgsmOnboardingService,
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
    AskAiService,
    // Phase F P2 — omnichannel: adapter registry + adapters (self-register on
    // init), message quota, the conversation services, and the AI engine
    // (subscribes to inbound events + registers its ScheduledJob handlers).
    ChannelAdapterRegistry,
    WebchatAdapter,
    WhatsappCloudAdapter,
    NetgsmSmsAdapter,
    MessengerAdapter,
    InstagramAdapter,
    TiktokDmAdapter,
    LinkedinEngagementAdapter,
    EmailChannelAdapter,
    MessageQuotaService,
    ChannelsService,
    ConversationStreamService,
    MessageSenderService,
    MessageReceiptService,
    ConversationIngressService,
    MetaLeadgenIngestService,
    ConversationsService,
    ConversationAiEngineService,
    PublicChannelResolverService,
    // NetGSM delivery reports are POLLED (not pushed): a per-minute, advisory-
    // locked sweeper that resolves still-pending outbound SMS via the report API.
    NetgsmReportClient,
    NetgsmDlrPollService,
    // Backup for the MO (inbound SMS) push webhook: hourly re-poll of NetGSM's
    // inbox() so panel misconfiguration (wrong/missing callback URL) doesn't
    // silently drop customer replies with no error visible to us.
    NetgsmMoPollService,
    // NetGSM Phase 4 Task 6 — voicemail (telesekreter) has no push webhook at
    // all, so this hourly poll of /voicesms/receive IS the (only) path a
    // voicemail reaches the shared inbox through, best-effort proxy-storing
    // the recording into R2 and transcribing it for a text preview.
    NetgsmVoicemailPollService,
    // NetGSM Phase 6 Task 2 — fax has no push webhook either, so this hourly
    // poll of /fax/receive IS the (only) path an inbound fax reaches the
    // shared inbox through, gated on the fax + conversationAi entitlements
    // (an active SMS channel alone does not imply either).
    NetgsmFaxPollService,
    // Blacklist sync (defense-in-depth): mirrors lead smsOptOut transitions
    // onto NetGSM's account-level blacklist — subscribes via DomainEventBus.
    NetgsmBlacklistSyncService,
    LinkedinEngagementPollService,
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
    // Slow reconciler (15-min tick): NetGSM per-jobid stats() rollups
    // (delivered/undelivered/blacklist/iysNotValid/…) into campaign.stats.sms.
    CampaignSmsStatsService,
    // NetGSM Phase 5 Task 3 — voice-report webhook consumer (registers its
    // bus subscription on init, like TelephonyEventConsumer/IysWebhookConsumer).
    VoiceReportConsumer,
    // NetGSM Phase 5 Task 4 — voice-campaign audio upload (.wav → audioid).
    VoiceAudioUploadService,
    // NetGSM Phase 6 Task 1 — send-fax action (PDF → NetGSM fax job).
    FaxSendService,
    // Phase F P5 — funnels: page/form CRUD + AI draft, the safe block renderer,
    // public form submit, and booking (registers the booking.reminder handler).
    SitesService,
    SiteRendererService,
    FormsService,
    LeadAttributionService,
    ChannelTariffService,
    SpendLedgerService,
    GrowthWalletService,
    AdSpendMirrorService,
    BudgetAnomalyService,
    BudgetQuickstartService,
    BudgetActivityService,
    SocialPostMetricService,
    BudgetPerformanceSource,
    BudgetAutopilotService,
    BudgetExecutorService,
    BudgetManagementService,
    ConversationSpendService,
    ResearchSpendService,
    FirecrawlProvider,
    ApifyProvider,
    ResearchSourcesService,
    ResearchJobService,
    ResearchCandidateService,
    ResearchWorkerService,
    ResearchRunnerService,
    BudgetPacerService,
    BudgetAutopilotCron,
    PerformanceLoopService,
    AgentRunService,
    BrandBrainService,
    TrendRemixService,
    VideoPipelineService,
    McpToolRegistry,
    McpBrokerService,
    AdWriteCapabilityService,
    VideoPersonaService,
    UnifiedCalendarService,
    ApprovalRequestService,
    BookingService,
    // Phase F P6 — reviews/reputation: request → rating-gate → public/private,
    // AI reply drafts (wired into the send_review_request workflow action).
    PipelinesService,
    OpportunitiesService,
    ProductsService,
    EstimatesService,
    SubscriptionsService,
    SubscriptionsSchedulerService,
    DocumentsService,
    OrderFormsService,
    AdAccountService,
    AdsPullService,
    TiktokBusinessOAuthService,
    AdManagementService,
    AudienceSyncService,
    AdRulesService,
    SnippetsService,
    LeadBulkService,
    TriggerLinksService,
    InboundWebhooksService,
    InboundWebhookGuard,
    CompaniesService,
    PageFunnelsService,
    EmailTemplatesService,
    EmailHygieneService,
    TaxRatesService,
    CouponsService,
    WalletService,
    ReviewsService,
    ReviewSyncService,
    ReviewOAuthService,
    AuditService,
    SendingDomainsService,
    CustomDomainsService,
    EspFeedbackService,
    // Phase F P8 — Voice AI: the VOICE channel adapter (config-only) + the
    // Twilio TwiML turn engine.
    VoiceAdapter,
    VoiceAiService,
    // Phase F P8 — configurable IVR / phone-tree menus over the Voice flow.
    IvrService,
    // Voice AI (NetGSM): STT + post-call analysis (+cron) + custom-LLM bridge +
    // NetGSM Özel-API IVR + live copilot. All inert behind env/capability flags.
    SttService,
    CallAnalysisService,
    CallAnalysisCron,
    VoiceAiBridgeService,
    NetgsmIvrService,
    CopilotService,
    // Phase F P9 — end-customer invoicing (per-workspace PSP, public pay page).
    InvoicesService,
    InvoiceTextService,
    // Phase F P10 — white-label-lite branding (logo upload + public theming).
    BrandingService,
    // Epic C — memberships.
    CoursesService,
    EnrollmentService,
    CertificateService,
    GamificationService,
    // Epic G — analytics.
    AnalyticsService,
    AttributionService,
    // Epic F (compliance).
    ComplianceService,
    // NetGSM Phase 2 Task 3 — İYS auto-push worker + enqueue helper.
    IysSyncService,
    // NetGSM Phase 2 Task 4 — İYS push-back webhook consumer (subscribes via
    // DomainEventBus on init).
    IysWebhookConsumer,
    // Epic E — funnel A/B + surveys.
    // Epic F — 2FA (TOTP + SMS).
    TwoFactorService,
    // NetGSM SMS v2 Task 12 — shared by TwoFactorService, MarketingAuthService
    // (login SMS challenge) and MarketingLeadsService (lead phone verify).
    SmsOtpService,
    // Epic B4 — Slack notify.
    SlackService,
    // Epic G — env-gated enterprise SSO (OIDC).
    SsoService,
    // Integrations — env-gated Google Calendar 2-way sync.
    GoogleCalendarService,
    OutlookCalendarService,
    GoogleCalendarSyncService,
    OutlookCalendarSyncService,
    // Conferencing (Meet / Teams) host resolution shared by both sync services.
    HostResolverService,
    // Advanced Meet spaces (Phase 4 — recording/transcript/co-host, env-gated).
    GoogleMeetSpacesService,
    // Epic F — custom roles + permissions.
    RolesService,
    PermissionsGuard,
    // GHL parity — affiliate manager.
    AffiliateService,
    // Epic D1 (GHL parity) — agency / sub-account hierarchy.
    AgencyService,
    RebillingService,
    // Epic D1 (GHL parity) — agency config snapshots.
    SnapshotService,
    // P11 (GoHighLevel parity): env-gated social media planner.
    SocialPlannerService,
    R2StorageService,
    // AI Social Content Studio — fal.ai media generation behind MediaProvider.
    FalProvider,
    { provide: MEDIA_PROVIDER, useExisting: FalProvider },
    MediaGenService,
    BrandKitService,
    SocialCampaignsService,
    SocialCampaignLinkService,
    SocialOAuthService,
    AccountCenterService,
    SocialTokenRefreshService,
    // Ad reporting — one-click LinkedIn-for-Business (ads) OAuth provisioning.
    LinkedinAdsOAuthService,
    GoogleAdsOAuthService,
    // Guards
    MarketingGuard,
    MarketingRolesGuard,
    IngestTokenGuard,
    AffiliatePortalGuard,
    FeatureGuard,
    ApiKeyGuard,
  ],
  exports: [
    MarketingAuthService,
    MarketingUsersService,
    // InternalApiModule's research-jobs surface shares the quota-clipped
    // ingest path (one implementation of the clipping invariant).
    MarketingLeadsIngestService,
    // InternalApiModule's lead-scoring surface delegates writes through this
    // service so the controller never touches marketing-owned tables directly.
    MarketingLeadsService,
    // Multi-workspace membership — the guard (Task 3) and auth service
    // (Tasks 4-7) inject this to resolve authorization from memberships.
    MembershipService,
  ],
})
export class MarketingModule {}
