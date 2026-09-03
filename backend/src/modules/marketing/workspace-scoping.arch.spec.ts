import * as fs from 'fs';
import * as path from 'path';

/**
 * Architecture-fitness test for workspace isolation (multi-tenancy).
 *
 * Every workspace-owned Prisma delegate call that can address MORE THAN ONE
 * ROW — or that CREATES a row — must mention `workspaceId` inside its
 * argument object, so no query can ever span workspaces and no row can be
 * born unscoped. Id-keyed single-row methods (findUnique / update / delete)
 * are exempt here because ids are unguessable UUIDs AND the service layer is
 * required to resolve them through a scoped read first — that part is
 * covered by the isolation unit specs, not static analysis.
 *
 * The check is a regex-and-brace-slice heuristic, deliberately simple: it
 * fails LOUD on a new unscoped call site and the fix (add workspaceId to the
 * where/data) is always the right move. If a future call site is legitimately
 * global, add it to ALLOWED_GLOBAL with a written justification.
 */

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const MODULE_DIR = path.join(BACKEND_ROOT, 'src/modules/marketing');

/** Prisma delegates owned by a workspace. */
const OWNED_DELEGATES = [
  'lead',
  'leadActivity',
  'leadOffer',
  'marketingUser',
  'marketingTask',
  'marketingNotification',
  'commission',
  'salesCall',
  // Epic 11b (preview dialer: call-queue sessions).
  'dialSession',
  'dialSessionItem',
  'installationCrew',
  'installationJob',
  'installationTask',
  'salesTarget',
  'marketingDistributionConfig',
  'researchProfile',
  'ingestToken',
  'usageCounter',
  // P1 (GoHighLevel parity): AI core + delayed-work primitive.
  'scheduledJob',
  'knowledgeDoc',
  'agentProfile',
  // P2 (GoHighLevel parity): omnichannel conversations.
  'channel',
  'contactIdentity',
  'conversation',
  'message',
  // P3 (GoHighLevel parity): workflow automation.
  'workflow',
  'workflowRun',
  'workflowStepRun',
  // P4 (GoHighLevel parity): campaigns.
  'campaign',
  'campaignRecipient',
  // P5 (GoHighLevel parity): funnels/sites + forms + booking.
  'sitePage',
  'formDef',
  'bookingCalendar',
  'booking',
  // Calendar types (GHL parity): round-robin / collective team members.
  'bookingCalendarMember',
  // P6 (GoHighLevel parity): reviews/reputation.
  'reviewSource',
  'review',
  // P8 (GoHighLevel parity): Voice AI (Twilio).
  'voiceCall',
  'voiceTranscript',
  // P8 (GoHighLevel parity): configurable IVR / phone-tree menus (over Voice).
  'ivrMenu',
  'ivrOption',
  // P9 (GoHighLevel parity): end-customer invoicing.
  'invoice',
  'workspacePspConfig',
  // P10 (GoHighLevel parity): white-label-lite branding.
  'workspaceBranding',
  // Epic A (CRM data model): custom fields, tags, segments, imports.
  'customFieldDef',
  'tag',
  'leadTag',
  'segment',
  'importJob',
  'importJobRow',
  // Epic B (public API + outbound webhooks).
  'apiKey',
  'webhookEndpoint',
  'webhookDelivery',
  // Epic F (compliance): GDPR/KVKK consent + data subject requests.
  'consentRecord',
  'dataRequest',
  // Epic E (funnel A/B experiments + surveys).
  'experiment',
  'experimentEvent',
  'survey',
  'surveyResponse',
  // Epic B4 (Slack incoming-webhook notifications).
  'slackIntegration',
  // Epic F (custom roles + granular permissions).
  'customRole',
  // Epic C (memberships: courses/lessons + enrollment/progress).
  'course',
  'courseModule',
  'lesson',
  'enrollment',
  'lessonProgress',
  // Epic 10b (memberships: completion certificates).
  'certificate',
  // Epic 10c (memberships: gamification — points ledger + badges).
  'pointsLedger',
  'badge',
  'earnedBadge',
  // Epic C (memberships: communities).
  'community',
  'communityMember',
  'communityPost',
  'communityComment',
  // Epic G (env-gated enterprise SSO via OIDC).
  'ssoConnection',
  // Integrations (env-gated Google Calendar 2-way sync).
  'googleCalendarConnection',
  // Integrations (env-gated Outlook/O365 calendar — Epic 12, inert).
  'outlookCalendarConnection',
  // Affiliate manager (GHL parity).
  'affiliate',
  'affiliateReferral',
  'affiliateCommission',
  // P11 (GoHighLevel parity): env-gated social media planner.
  'socialAccount',
  'socialPost',
  'socialPostTarget',
  // Organic-insights read path: per-post and per-account metric snapshots.
  // Both carry workspaceId and both are written by an hourly cross-workspace
  // cron, which is exactly the shape that needs a guard rather than trust.
  'socialPostMetric',
  'socialAccountMetric',
  // NetGSM telephony config — the highest-value row in the module: its
  // configSealed holds the santral usercode/password. Three system crons
  // enumerate it across workspaces (they project workspaceId and never touch
  // the sealed column); those are exempted by name below, so a fourth,
  // less careful read cannot slip in unnoticed.
  'telephonyConfig',
  // Epic D1 (GHL parity): agency config snapshots (owned by the capturing agency).
  'snapshot',
  // Epic D1 (GHL parity): agency rebilling / SaaS-mode — per-location SaaS plans +
  // monthly settlement charges, both OWNED by the agency (workspaceId = agency id).
  'rebillingPlan',
  'rebillCharge',
  // Sales Opportunities + Pipelines (GHL parity): kanban sales spine. Stages
  // and opportunities carry workspaceId on every multi-row/create call; the
  // Pipeline→Stage→Opportunity FKs keep intra-feature integrity.
  'pipeline',
  'pipelineStage',
  'opportunity',
  // Products catalog (GHL parity): workspace-owned priced items.
  'product',
  // Estimates / quotes (GHL parity): priced documents owned by the workspace.
  'estimate',
  // Recurring customer subscriptions (GHL parity): workspace-owned.
  'customerSubscription',
  // E-signature documents / contracts (GHL parity): workspace-owned.
  'document',
  // Public payment-enabled order forms (GHL parity): workspace-owned config.
  'orderForm',
  // Ad reporting (GHL parity): each workspace connects its OWN Meta/TikTok ad
  // account (sealed token) and the pulled per-day metric rows are workspace-owned.
  'adAccount',
  'adMetric',
  // Ad management + automated scaling rules (Meta) — workspace-owned; the
  // hourly eval sweep (cross-workspace) is whitelisted in ALLOWED_GLOBAL.
  'adRule',
  'adRuleLog',
  // CRM segment → Meta Custom Audience sync state (one row per segment+account).
  'segmentAudienceSync',
  // Granular ad-level breakdown metrics (reporting-only, separate from AdMetric).
  'adMetricBreakdown',
  // Custom Objects (GHL parity): workspace-defined record types, their records,
  // and record↔Contact links are all workspace-owned.
  'customObjectDef',
  'customObjectRecord',
  'customObjectLink',
  // Inbox productivity (GHL parity): canned-response snippets + internal notes.
  'messageSnippet',
  'conversationNote',
  // Trigger links (GHL parity): trackable short links + their click rows.
  'triggerLink',
  'triggerLinkClick',
  // Inbound webhooks (GHL parity): per-workspace public hook endpoints.
  'inboundWebhook',
  // Companies (GHL parity): B2B accounts grouping contacts.
  'company',
  // Multi-step page funnels (GHL parity).
  'funnel',
  // HTML email templates (GHL parity).
  'emailTemplate',
  // Campaign A/B variants (GHL parity).
  'campaignVariant',
  // Tax rates (GHL parity): reusable per-workspace KDV/VAT rates.
  'taxRate',
  // Coupons (GHL parity): discount codes + their redemption log.
  'coupon',
  'couponRedemption',
  // Customer wallet (GHL parity): store-credit + its append-only ledger.
  'customerWallet',
  'walletLedgerEntry',
  // Prospecting audits (GHL parity, Epic 13): workspace-owned website audits;
  // every multi-row/create call carries workspaceId (public read is by token).
  'prospectAudit',
  // Sending domains / DKIM (GHL parity, Epic 13): workspace-owned email sending
  // domains; every multi-row/create call carries workspaceId.
  'sendingDomain',
  // Custom-domain white-label (GHL parity, Epic 13): workspace-owned hostnames.
  // Writes/reads are workspaceId-scoped; the host lookup is findUnique (by the
  // globally-unique hostname) and the verify sweep is whitelisted below.
  'customDomain',
  // Multi-workspace membership (Phase 2 Task 11: the invite endpoint) —
  // WorkspaceMembership is workspace-owned (one row per user-per-workspace);
  // every multi-row/create call carries a literal workspaceId EXCEPT the two
  // userId-keyed authz-resolution reads exempted below (a user spans
  // workspaces by design).
  'workspaceMembership',
  // Brand Brain (Task 2): the workspace's consolidated brand/product profile
  // — one row per workspace, keyed by a unique workspaceId.
  'brandProfile',
  // Brand Brain (Task 12): one async brand-extraction run per invocation —
  // startAnalysis's create carries a literal workspaceId.
  'brandAnalysisRun',
  // Strategy Engine (P5): per-workspace connected community channels
  // (Discord webhook / Reddit OAuth), sealed. One row per (workspaceId, provider);
  // every findMany/deleteMany/upsert carries a literal workspaceId.
  'communityChannelConfig',
] as const;

/**
 * Epic D1 (agency / sub-account hierarchy) note — the `workspace` delegate is
 * DELIBERATELY NOT in OWNED_DELEGATES above (a Workspace is the tenant root, not
 * a workspace-owned row), so this check does not — and should not — scan the
 * agency.service.ts cross-into-child reads (`workspace.findFirst` /
 * `.findMany` keyed on `parentWorkspaceId`, and the LOCATION child-create).
 * Those are the ONE sanctioned cross-workspace path; they are legitimate
 * because every one of them is guarded by `assertAgencyOwns(agencyWorkspaceId,
 * locationId)` — the parent-ownership invariant — NOT by a workspaceId column.
 * The owned-delegate writes that agency.service.ts DOES make (marketingUser /
 * marketingDistributionConfig creates for the new location, and lead /
 * marketingUser counts in the dashboard) all carry an explicit `workspaceId`
 * for the child, so they pass the check below unchanged. Leaving `workspace`
 * out of the delegate list is the honest, documented exemption — not a
 * loosened check.
 */

/** Methods that can address many rows or create rows. */
const SCOPED_METHODS = [
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
  'upsert',
  'create',
  'createMany',
] as const;

/**
 * Call sites that are global ON PURPOSE. Key: `<file>:<delegate>.<method>`,
 * value: why it may span workspaces. Keep this list SHORT — every entry is
 * a standing exception auditors must re-justify.
 *
 * A key names a FILE and a DELEGATE.METHOD, not a line — so on its own it
 * would exempt every `channel.findMany` in that file, including a sibling
 * the justification was never written for. `ALLOWED_GLOBAL_SITES` closes
 * that: each key is pinned to how many unscoped calls it is allowed to
 * silence (1 unless stated), so a second one — a NEW global read, or a
 * scoped sibling that LOSES its `workspaceId` — fails instead of inheriting
 * a neighbour's exemption. See the 'exemptions are pinned…' test below.
 */
const ALLOWED_GLOBAL: Record<string, string> = {
  // The hourly sweep that keeps consent-connected mailboxes sending. A system
  // job, like SocialTokenRefreshService: it must see every tenant's due tokens
  // or those mailboxes go quiet an hour after they are connected. It selects
  // `id` + the sealed box only — no row data crosses a tenant boundary — and
  // every write it makes is keyed by that id. Deliberately UNFILTERED and
  // un-take()d: the expiry lives inside the AES box, so there is no column to
  // page on, and a take(N) here would pin the sweep to the same N rows forever.
  'channels/email-oauth-refresh.service.ts:channel.findMany':
    'system job: refreshes every tenant due OAuth mail token; selects id+sealed box only, writes are id-keyed',
  // Already scoped through its parent: the ids come from a
  // workspaceMembership.findMany that IS workspace-filtered, so this reads
  // only that workspace's members. Filtering on MarketingUser.workspaceId
  // instead would be wrong, not stricter — that column is the user's HOME
  // workspace, so an owner whose home is elsewhere would silently drop off
  // the morning brief.
  'analytics/daily-digest.service.ts:marketingUser.findMany':
    'recipients(): ids come from a workspace-scoped membership read; user.workspaceId is the home pointer, not membership',
  // The ownership cap asks "how many workspaces does this identity already
  // own", which is a question ACROSS workspaces by definition — scoping it to
  // one would always answer 1 and the cap would never bite. It reads a count
  // only, never row data, and is keyed on the caller's own userId.
  'services/marketing-auth.service.ts:workspaceMembership.count':
    "createOwnedWorkspace: counts one identity's owned workspaces, deliberately cross-workspace",
  // (marketingUser.create needed an entry when registerWorkspace built its
  // rows through a hoisted `data` variable. Both call sites now pass
  // `workspaceId` inline, so the detector sees the scope itself and the
  // exemption is gone — kept as a note because the shape is easy to
  // reintroduce.)
  // LeadActivity/InstallationTask are scoped via their parent (leadId/jobId
  // is resolved through a workspace-scoped read in the same service call).
  // Creates that pass a parent id resolved in-scope are tolerated wholesale:
  'parent-scoped:leadActivity.create':
    'activity rows inherit scope from a lead resolved via a scoped read',
  'parent-scoped:leadActivity.createMany':
    'bulk activity rows inherit scope from leads resolved via a scoped findMany (bulkAssign)',
  'parent-scoped:leadActivity.deleteMany':
    "erasure (KVKK/GDPR) deletes a lead's activity rows by a leadId resolved via a workspace-scoped dataRequest read; LeadActivity has no workspaceId column",
  'parent-scoped:installationTask.create':
    'checklist rows inherit scope from a job resolved via a scoped read',
  'parent-scoped:installationTask.createMany':
    'checklist rows inherit scope from a job resolved via a scoped read',
  'parent-scoped:installationTask.updateMany':
    'mutations are keyed by (id, jobId) with the job resolved via a scoped read',
  // Lesson / LessonProgress have NO workspaceId column — a Lesson is owned via
  // Course (workspaceId on Course) and LessonProgress via Enrollment. Every call
  // is keyed by a moduleId / lessonId / courseId that was resolved through a
  // workspace-scoped read (assertModule / assertLesson / recomputeCourseProgress),
  // so it cannot span workspaces.
  'parent-scoped:lesson.findMany':
    'lessons addressed by moduleId/courseId resolved via a scoped assertModule/assertLesson; Lesson is workspace-owned through Course',
  'parent-scoped:lessonProgress.deleteMany':
    'progress rows deleted by lessonId(s) of lessons resolved via a scoped read; LessonProgress is workspace-owned through Enrollment',
  // ScheduledJob is a single global sweeper primitive: one runner claims due
  // rows across ALL workspaces, and dedup/cancel key on (kind, dedupKey) — the
  // partial-unique index deliberately omits workspaceId, and dedupKeys embed
  // unguessable row UUIDs so cross-workspace collision is impossible. The
  // create path DOES carry workspaceId (every job is owned); only these
  // global control-plane reads/sweeps below are legitimately unscoped.
  'scheduling/scheduled-job.service.ts:scheduledJob.findFirst':
    'dedup lookup keyed by (kind, dedupKey) — matches the partial-unique index, global by design',
  'scheduling/scheduled-job.service.ts:scheduledJob.updateMany':
    'cancel by (kind, dedupKey) or by id — control-plane mutation; dedupKey embeds a row UUID',
  // (the stuck-reaper now runs conflict-safe raw SQL, not a Prisma delegate call)
  // Recurring-subscription sweep: the hourly cron reads due ACTIVE subscriptions
  // across ALL workspaces (status + nextBillingAt) — a system job, same shape as
  // the scheduled-job runner. Every write it triggers (billOne) is workspace-
  // scoped or id-keyed, and the (subscription, period) partial-unique index makes
  // a duplicate invoice impossible. The lookup lives in this single scheduler file.
  'subscriptions/subscriptions-scheduler.service.ts:customerSubscription.findMany':
    'hourly recurring-invoice sweep reads due rows across all workspaces (system cron)',
  // Ad-insights sweep: the hourly cron reads due ACTIVE ad accounts across ALL
  // workspaces (status + lastPulledAt) — a system job, same shape as the
  // subscription sweep. Every write it triggers (pullAccount: adMetric.upsert,
  // adAccount.update) carries an explicit workspaceId or is id-keyed, and the
  // (adAccountId, date, campaignId) unique index makes a re-pull idempotent.
  'ads/ads-pull.service.ts:adAccount.findMany':
    'hourly ad-insights sweep reads due ad accounts across all workspaces (system cron)',
  // Ad-rules eval sweep: the hourly cron reads ENABLED rules whose account is
  // ACTIVE+META across ALL workspaces — a system job, same shape as the ads
  // sweep. Every action it triggers is workspace-scoped (campaigns/setBudget/
  // setStatus all resolve via the rule's workspaceId) and id-keyed; the per-
  // (rule,campaign) cooldown log guards against thrashing. list() in the same
  // file IS workspace-scoped.
  'ads/ad-rules.service.ts:adRule.findMany':
    'hourly ad-rules eval sweep reads enabled rules across all workspaces (system cron)',
  // Post-call AI-analysis sweep (Voice AI, inert): the 30-min cron reads CONNECTED
  // calls that have a recording but no analysis across ALL workspaces — a system
  // job, same shape as the recording/ads sweeps. Every write it triggers
  // (call_analyses upsert) is keyed by the unique salesCallId and is idempotent.
  'voice-ai/call-analysis.cron.ts:salesCall.findMany':
    'half-hourly post-call analysis sweep reads ended recorded calls missing analysis across all workspaces (system cron)',
  // Custom-LLM bridge (Voice AI, inert): a PUBLIC endpoint an AI voice partner
  // (VAPI/Retell/ElevenLabs) calls, authenticated by a shared bearer secret — no
  // workspace context exists on the request. It resolves the VOICE channel by its
  // (id, type) handle the operator pasted into the partner config; all downstream
  // metering/KB/agent reads are keyed off the resolved channel's OWN workspaceId.
  'voice-ai/voice-ai-bridge.controller.ts:channel.findFirst':
    'public partner-LLM bridge resolves the VOICE channel by id before any workspace context exists (bearer-secret authed)',
  // Meta's data-deletion callback (App Review prerequisite): a PUBLIC endpoint
  // Meta POSTs a signed_request to, authenticated ONLY by the HMAC over that
  // payload. It carries a platform-scoped user id and NO tenant context at all,
  // so "which tenants hold this id" is a question across workspaces by
  // definition — scoping the probe would need a workspaceId nobody can supply.
  // The probe projects only workspaceId + leadId, and every step after it is
  // scoped to the workspaceId the MATCHED ROW ITSELF carries: the erasure runs
  // through ComplianceService.requestErasure/fulfillErasure, both of which
  // re-resolve the lead/request under that workspaceId before touching a row.
  // Runtime proof that no match ever crosses tenants lives in
  // platform-data-deletion.service.spec.ts ('erases each match under its OWN
  // workspace'), which cross-stamps two tenants holding the same id.
  'compliance/platform-data-deletion.service.ts:contactIdentity.findMany':
    'Meta data-deletion callback resolves a platform-scoped id before any workspace context exists; each match is then erased under its own workspaceId',
  // Review-sync sweep (Epic 13, inert): the hourly cron reads ACTIVE review
  // sources with a token across ALL workspaces — a system job, same shape as the
  // ads/recording sweeps. Every write it triggers (review upsert / source update)
  // is workspace-scoped or id-keyed, and the (sourceId, externalReviewId) unique
  // makes a re-sync idempotent.
  'reviews/review-sync.service.ts:reviewSource.findMany':
    'hourly review-sync sweep reads ACTIVE review sources with a token across all workspaces (system cron)',
  // OAuth token-refresh sweep: the hourly cron reads OAUTH social accounts with a
  // refresh token nearing expiry across ALL workspaces — a system job, same shape
  // as the subscription/ads sweeps. Every write it triggers (socialAccount.update)
  // is id-keyed, and the refresh is idempotent (re-seals the latest token).
  'social-planner/oauth/social-token-refresh.service.ts:socialAccount.findMany':
    'hourly OAuth token-refresh sweep reads expiring accounts across all workspaces (system cron)',
  // Organic-insights sweep: the hourly cron reads DUE social accounts across ALL
  // workspaces — the same system-job shape as the token-refresh sweep directly
  // above, and it needed the same written exemption. It did not have one and
  // passed anyway, because its `select: { id: true, workspaceId: true }`
  // satisfied a check that only asked whether the string appeared somewhere in
  // the arguments; the detector below no longer counts a mention inside
  // select/orderBy/include, so this entry is now load-bearing. Everything the
  // sweep does after the probe is workspace-scoped: it groups the rows by
  // workspaceId and hands each workspace its own id allowlist to
  // pullWorkspaceExclusive, which inlines workspaceId on every query.
  'social-planner/social-insights.cron.ts:socialAccount.findMany':
    'hourly organic-insights sweep reads due accounts across all workspaces (system cron); selects only id + workspaceId',
  // ── Exposed by closing the projection hole ────────────────────────────────
  // The seven entries below are not new call sites and not new risk: every one
  // of them predates this test's tightening and passed only because it PROJECTED
  // workspaceId in a `select`. They are all the sanctioned system-job shape —
  // enumerate the world once, then carry each row's own workspaceId into every
  // downstream query — and each has been read and confirmed as such. They are
  // written down now because that is the deal the header sets out: a
  // legitimately global call site earns an exemption with a justification, not
  // silence.
  //
  // SMS delivery-receipt reconcile: a nightly sweep over SMS campaigns still
  // SENDING (or completed inside the lookback) across ALL workspaces, so it can
  // ask NetGSM about their job ids. Every stats write is keyed by the campaign
  // row's own id + workspaceId.
  'campaigns/campaign-sms-stats.service.ts:campaign.findMany':
    'nightly SMS stats reconcile enumerates in-flight SMS campaigns across all workspaces (system cron); each row carries its own workspaceId into the write',
  // The four NetGSM pollers: NetGSM exposes ONE inbound queue per account, so
  // the poller has to enumerate every ACTIVE SMS channel to know which sealed
  // credentials to poll with. Each channel row carries its workspaceId and every
  // ingest below is scoped to it.
  'channels/netgsm-dlr-poll.service.ts:channel.findMany':
    'delivery-receipt poller enumerates ACTIVE SMS channels across all workspaces (system cron); ingest is scoped by each row workspaceId',
  'channels/netgsm-fax-poll.service.ts:channel.findMany':
    'inbound-fax poller enumerates ACTIVE SMS channels across all workspaces (system cron); ingest is scoped by each row workspaceId',
  'channels/netgsm-mo-poll.service.ts:channel.findMany':
    'inbound-SMS (MO) poller enumerates ACTIVE SMS channels across all workspaces (system cron); ingest is scoped by each row workspaceId',
  'channels/netgsm-voicemail-poll.service.ts:channel.findMany':
    'voicemail poller enumerates ACTIVE SMS channels across all workspaces (system cron); ingest is scoped by each row workspaceId',
  // CDR-sync sweep: the 5-minute cron asks which workspaces could possibly have
  // NetGSM CDR credentials, by enumerating ACTIVE SMS channels across ALL
  // workspaces — the same system-job shape as the four NetGSM pollers above, and
  // it needed the same written exemption. It did not have one and passed anyway,
  // because `distinct: ['workspaceId']` satisfied a check that only asked whether
  // the string appeared outside a select; a de-duplication key restricts nothing.
  // It reads the workspace id and nothing else, and every call that follows goes
  // through syncWorkspace(workspaceId), which inlines it.
  'telephony/call-cdr-sync.service.ts:channel.findMany':
    'CDR-sync cron enumerates ACTIVE SMS channels across all workspaces to find candidates (system cron); selects and de-dupes on workspaceId only',
  // The other half of that same candidate query, and the two recording crons.
  // TelephonyConfig is where the sealed santral credentials live, so the bar
  // for a global read of it is: project workspaceId (plus a plain, unsealed
  // policy column), never `configSealed`, and hand every id straight to a
  // per-workspace call that re-reads with scope. All three do.
  'telephony/call-cdr-sync.service.ts:telephonyConfig.findMany':
    'CDR-sync cron enumerates ACTIVE telephony configs across all workspaces (system cron); selects workspaceId only, then syncWorkspace(workspaceId)',
  'telephony/recording-ingest.service.ts:telephonyConfig.findMany':
    'recording-ingest cron asks which workspaces have recordCalls ON (system cron); selects workspaceId only, no sealed column read',
  'telephony/recording-retention.service.ts:telephonyConfig.findMany':
    'retention sweep reads each workspace recordingRetentionDays (system cron); selects workspaceId + the plain retention column, no sealed column read',
  // Inbound-call routing: the only thing an arriving call carries is the dialled
  // number, so the workspace has to be DERIVED from it. This is the one global
  // read here that is a routing decision rather than a sweep, and it is the most
  // carefully written: it takes at most five candidates and REFUSES to answer
  // when they span more than one workspace, rather than picking one and reading
  // another tenant's knowledge base aloud to the caller.
  'voice-ai/netgsm-ivr.service.ts:channel.findMany':
    'inbound-call routing derives the workspace from the dialled number across all workspaces; refuses on cross-workspace ambiguity rather than guessing',
  // Course progress recompute: parent-scoped by courseId — an unguessable
  // workspace-owned id the caller has already resolved through a scoped read,
  // the same rationale as the parent-scoped: lesson/lessonProgress entries
  // above. It is the only enrollment.findMany in the file.
  'memberships/courses.service.ts:enrollment.findMany':
    'progress recompute is parent-scoped by courseId (resolved through a workspace-scoped read first); rows carry their own workspaceId',
  // ESP delivery-feedback suppression: a hard bounce / spam complaint reported by
  // the ESP carries only the dead address, no workspace — and the address is
  // undeliverable EVERYWHERE, so suppression (emailBouncedAt + emailOptOut) is
  // intentionally global by normalized email across all workspaces.
  'channels/esp-feedback.service.ts:lead.updateMany':
    'ESP bounce/complaint suppression is global by address (no workspace in the event; a dead address is dead everywhere)',
  // Custom-domain verify sweep (Epic 13, inert): the hourly cron reads PENDING
  // custom domains across ALL workspaces — a system job, same shape as the
  // ads/review/recording sweeps. Every write it triggers (customDomain.updateMany
  // → VERIFIED) is keyed by (id, workspaceId), and re-verifying is idempotent.
  'custom-domains/custom-domains.service.ts:customDomain.findMany':
    'hourly custom-domain verify sweep reads PENDING domains across all workspaces (system cron)',
  // Public e-signature sign/decline: the document id is resolved from a
  // token-scoped findUnique(publicToken) (the unguessable token IS the
  // capability), then the status-conditional updateMany flips SENT→SIGNED/DECLINED
  // by id. No workspace context exists on the public signer route — same
  // sanctioned token-scoped pattern the public invoice/estimate flows use. (The
  // manager send() updateMany DOES carry workspaceId.)
  'documents/documents.service.ts:document.updateMany':
    'public sign/decline keyed by id from a token-scoped findUnique(publicToken)',
  // Campaign open/click/unsubscribe tracking: the recipient is resolved from a
  // token-scoped findUnique(token) (the unguessable per-recipient token IS the
  // capability), then a status-conditional updateMany claims it BY PRIMARY KEY
  // (where.id = r.id + openedAt/clickedAt/status guard) so only the first of
  // near-simultaneous hits counts. No workspace context exists on the public
  // pixel/redirect/unsub routes; the id PK touches at most that one row. Same
  // sanctioned token-scoped pattern as documents/public-invoice.
  'campaigns/campaign-tracking.service.ts:campaignRecipient.updateMany':
    'public open/click/unsub tracking keyed by id from a token-scoped findUnique(token); race-safe conditional claim, no cross-tenant surface',
  // Inbound public webhooks have NO workspace context — the provider only
  // gives a widget key or a page/phone id. This lookup (the ONLY cross-workspace
  // channel access) lives in one resolver so the exemption surface is a single
  // auditable file; it keys on the globally-unique (type, externalId) handle the
  // workspace registered, so it can't leak across tenants. (NetGSM delivery
  // status is no longer flipped by an unauthenticated push — it's polled per
  // message by id in NetgsmDlrPollService — so that exemption is gone.)
  'channels/public-channel-resolver.service.ts:channel.findFirst':
    'meta webhook resolves the channel by its provider page/phone id before any workspace context exists',
  // Google Calendar push-webhook has NO workspace context — Google only sends
  // the watch channel id. channelId is UNIQUE (one connection per channel), so
  // this resolver (the ONLY unscoped connection read) keys on a globally-unique
  // handle the workspace itself registered; it can't leak across tenants.
  'integrations/google-calendar-sync.service.ts:googleCalendarConnection.findFirst':
    'google push-webhook resolves the connection by its unique watch channelId before any workspace context exists',
  // The watch-renewal @Cron is a global control-plane sweep (like the
  // scheduled-job runner): it re-registers push channels nearing expiry across
  // ALL workspaces. The other findMany in this file (pullWorkspace) IS
  // workspace-scoped; the create/update paths (startWatch/stopWatch) all key on
  // (id, workspaceId), so only this renewal sweep is legitimately unscoped.
  'integrations/google-calendar-sync.service.ts:googleCalendarConnection.findMany':
    'watch-renewal cron re-registers expiring push channels across all workspaces (control-plane sweep)',
  // Outlook/O365 (Graph) sync — the exact analogues of the Google entries above.
  // The notification webhook carries only the Graph subscriptionId (UNIQUE, one
  // connection per subscription); pullBySubscription resolves the connection by
  // it before any workspace context exists. The other findFirst calls in this
  // file (activeConnection, ensureSubscription) DO key on workspaceId.
  'integrations/outlook-calendar-sync.service.ts:outlookCalendarConnection.findFirst':
    'graph notification webhook resolves the connection by its unique subscriptionId before any workspace context exists',
  // The subscription-renewal @Cron is a global control-plane sweep: it renews
  // Graph subscriptions nearing expiry across ALL workspaces. The other findMany
  // (pullWorkspace) IS workspace-scoped; every create/update path keys on
  // (id, workspaceId), so only this renewal sweep is legitimately unscoped.
  'integrations/outlook-calendar-sync.service.ts:outlookCalendarConnection.findMany':
    'subscription-renewal cron renews expiring Graph subscriptions across all workspaces (control-plane sweep)',

  // ---- Epic A imports — ImportJobRow has NO workspaceId column; it is owned by
  // its parent ImportJob (which carries workspaceId). Every row op keys on
  // importJobId, and the job is created/loaded in the same workspace-scoped
  // flow (createCsv carries workspaceId; processBatch runs off a workspace-owned
  // ScheduledJob payload). Scope is inherited from the parent, not the column.
  'parent-scoped:importJobRow.createMany':
    'rows are created under a job just created with workspaceId (createCsv)',
  'parent-scoped:importJobRow.findMany':
    'batch read keyed by importJobId; the job is the workspace-owned scope anchor',
  'parent-scoped:importJobRow.count':
    'remaining-row count keyed by importJobId; scoped via the parent ImportJob',

  // ---- Epic A tags — LeadTag is a join table with NO workspaceId column
  // (composite PK [leadId, tagId]). Every op resolves the Lead via a scoped
  // assertLead/findMany and the tags via resolveOrCreate(workspaceId, …) first,
  // so leadId/tagId are already workspace-bound. lead-dedupe re-parents under a
  // scoped lead.findMany (the same parent-scoped pattern as leadActivity).
  'parent-scoped:leadTag.findMany':
    'keyed by a leadId resolved through a workspace-scoped read',
  'parent-scoped:leadTag.createMany':
    'links a scoped lead to tags from resolveOrCreate(workspaceId, …)',
  'parent-scoped:leadTag.deleteMany':
    'keyed by a leadId/tagIds resolved through workspace-scoped reads',
  'parent-scoped:leadTag.updateMany':
    'dedupe re-parents tags under leads resolved via a scoped lead.findMany',

  // ---- Epic C memberships — CourseModule/Lesson/LessonProgress/CommunityMember
  // have NO workspaceId column; they hang off Course/Module/Enrollment/Community
  // which DO. Every op below is preceded by an assert* that resolves the parent
  // via a workspace-scoped read, so the child key (courseId/moduleId/
  // enrollmentId/communityId) is already workspace-bound.
  'parent-scoped:courseModule.count':
    'module count keyed by a courseId resolved via assertCourse(workspaceId, …)',
  'parent-scoped:courseModule.create':
    'module created under a course resolved via assertCourse(workspaceId, …)',
  'parent-scoped:courseModule.updateMany':
    'reorder keyed by (id, courseId) with the course resolved via a scoped read',
  'parent-scoped:courseModule.aggregate':
    'max(position) append keyed by a courseId resolved via assertCourse(workspaceId, …)',
  'parent-scoped:lesson.count':
    'lesson count keyed by a courseId/module resolved via a scoped read',
  'parent-scoped:lesson.aggregate':
    'max(position) append keyed by a moduleId resolved via assertModule(workspaceId, …)',
  'parent-scoped:lesson.updateMany':
    'delete-gap renumber keyed by a moduleId from a workspace-scoped assertLesson; Lesson has no workspaceId column',
  'parent-scoped:lesson.create':
    'lesson created under a module resolved via assertModule(workspaceId, …)',
  'parent-scoped:lesson.findFirst':
    'lesson resolved through its module/course after a scoped enrollment read',
  'parent-scoped:lessonProgress.findMany':
    'progress keyed by an enrollmentId resolved via assertEnrollment(workspaceId, …)',
  'parent-scoped:lessonProgress.upsert':
    'progress keyed by (enrollmentId, lessonId) under a scoped enrollment',
  'parent-scoped:lessonProgress.count':
    'completed count keyed by an enrollmentId resolved via a scoped read',
  'parent-scoped:lesson.findMany':
    'lessons of a moduleId/courseId resolved via assertModule/assertLesson (or a scoped caller of recomputeCourseProgress); Lesson has no workspaceId column',
  'parent-scoped:lessonProgress.deleteMany':
    'orphan-progress cleanup keyed by lessonId(s) from a workspace-scoped assertModule/assertLesson; LessonProgress has no workspaceId column',
  // These models DO carry workspaceId and ARE scoped — but via a hoisted
  // `where`/`data` variable the static regex can't read through, so the arg slice
  // has no literal "workspaceId". File-specific (not parent-scoped): the scope is
  // real, only the heuristic is blind.
  // (leadOffer.findMany/count needed entries while their where lived in a
  // hoisted variable. Both now spread it inline — `{ ...where, workspaceId }`
  // — so the scope is literally visible and the exemptions are gone.)
  'services/marketing-research.service.ts:researchProfile.create':
    'row created with { workspaceId } via a ResearchProfileUncheckedCreateInput data variable; heuristic cannot see through the data variable',
  'strategy/executors/lead-hunt.executor.ts:researchProfile.create':
    'LEAD_HUNT executor materializes the action payload as a ResearchProfile with { workspaceId } via a ResearchProfileUncheckedCreateInput data variable; heuristic cannot see through the data variable',
  'ai/agent-profile.service.ts:agentProfile.create':
    'row created via a data var from toData(workspaceId, dto) (fast path + advisory-lock tx); heuristic cannot see through the data variable',
  'ai/knowledge.service.ts:knowledgeDoc.create':
    'row created with { ...data, workspaceId } data var (fast path + advisory-lock tx); heuristic cannot see through the data variable',
  'sites/sites.service.ts:sitePage.create':
    'row created with { workspaceId, ... } data var (fast path + advisory-lock tx); heuristic cannot see through the data variable',
  'parent-scoped:communityMember.upsert':
    'membership keyed by (communityId, leadId) under assertCommunity(workspaceId, …)',
  'parent-scoped:communityMember.deleteMany':
    'leave keyed by (communityId, leadId) under a scoped community read',
  'parent-scoped:communityMember.findMany':
    'roster keyed by a communityId resolved via assertCommunity(workspaceId, …)',

  // Multi-workspace membership (Phase 1 Task 2) — MembershipService is the
  // authz-resolution seam: a MarketingUser identity spans N workspaces via
  // WorkspaceMembership rows, so its reads are legitimately keyed by userId
  // rather than workspaceId. WorkspaceMembership DOES carry a workspaceId
  // column (it is workspace-owned), so these two call sites are exempted
  // explicitly rather than by omitting the delegate from OWNED_DELEGATES.
  'services/membership.service.ts:workspaceMembership.findFirst':
    'getActiveMembership/resolveDefaultWorkspaceId resolve a membership by (userId, workspaceId) or by userId alone (home-pointer fallback) — a user spans workspaces, so this read is workspace-less by design',
  'services/membership.service.ts:workspaceMembership.findMany':
    'listActiveMemberships reads every ACTIVE membership a user holds, across all their workspaces, keyed by userId',
};

/**
 * How many unscoped call sites each exemption is allowed to silence.
 * Absent key = exactly 1. Raise a number ONLY after reading every site it
 * now covers and judging each one global on purpose; the count is the
 * audit, so a bare bump defeats the whole mechanism.
 *
 * `parent-scoped:` keys are deliberately unpinned — they say "this delegate
 * is reached through its parent" as a shape that recurs across files, so
 * counting them would pin an unrelated total that moves with every new
 * call site.
 */
const ALLOWED_GLOBAL_SITES: Record<string, number> = {
  // Two creates of the SAME `data` object (which carries workspaceId, just
  // behind a variable): one on the unlimited-plan fast path, one inside the
  // advisory-lock transaction that enforces the plan cap.
  'ai/agent-profile.service.ts:agentProfile.create': 2,
  'ai/knowledge.service.ts:knowledgeDoc.create': 2,
  'services/marketing-research.service.ts:researchProfile.create': 2,
  'sites/sites.service.ts:sitePage.create': 2,
  // open / click / unsubscribe — three race-safe claims, each keyed by the
  // recipient PRIMARY KEY resolved from the unguessable per-recipient token.
  'campaigns/campaign-tracking.service.ts:campaignRecipient.updateMany': 3,
  // byExternalId (routing, ACTIVE-only) + anyByExternalId (registration
  // guard, status-blind). Both are the webhook identity lookup this file
  // exists to contain.
  'channels/public-channel-resolver.service.ts:channel.findFirst': 2,
  // sign + decline, both keyed by the id from a token-scoped findUnique.
  'documents/documents.service.ts:document.updateMany': 2,
  // The (kind, dedupKey) dedup lookup, plus the P2002 loser's re-read of the
  // winner on the same key.
  'scheduling/scheduled-job.service.ts:scheduledJob.findFirst': 2,
  // cancel(kind, dedupKey) + cancelById(id). NOTE: cancelById currently has
  // no caller outside tests — if it ever gets a route, that route owes a
  // workspace check, because this write does not carry one.
  'scheduling/scheduled-job.service.ts:scheduledJob.updateMany': 2,
};

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
      out.push(full);
  }
  return out;
}

/** Slice the balanced (...) argument block starting at `openParen`. */
function sliceArgs(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(openParen, i + 1);
    }
  }
  return src.slice(openParen);
}

/**
 * Blocks that mention `workspaceId` without FILTERING on it.
 *
 * `select`, `orderBy` and `include` are projections and sorts: they name a
 * column, they do not restrict which rows come back. A query that reads every
 * row in the database and merely PROJECTS the workspace id is exactly the
 * cross-tenant read this fitness test exists to catch, and until now it was the
 * one shape guaranteed to slip through — the check was a plain
 * `args.includes('workspaceId')`, so `select: { workspaceId: true }` read as a
 * tenant filter. The organic-insights sweep walked straight through that hole
 * while its identical sibling (social-token-refresh) had to be exempted by hand,
 * which is how you can tell it was a hole and not a policy.
 *
 * `distinct` and groupBy's `by` are the same hole wearing a different bracket.
 * They take an ARRAY of column names rather than an object, so the first pass at
 * this stripped neither, and `distinct: ['workspaceId']` — a de-duplication key,
 * which restricts nothing — read as a tenant filter exactly the way
 * `select: { workspaceId: true }` used to. That is not hypothetical: the 5-minute
 * CDR-sync cron's channel read is precisely that shape, and it sat here green and
 * unexempted while doing the same legitimately-global thing its neighbours had to
 * write down.
 *
 * Removing these blocks before the check is deliberately blunt. The cost of a
 * false positive is one line in ALLOWED_GLOBAL with a written justification —
 * which is the process working. The cost of a false negative is a silent
 * cross-tenant read that the suite reports green.
 */
const NON_FILTER_KEYS = ['select', 'orderBy', 'include', '_count', '_sum', '_avg', '_min', '_max'];
/** The array-valued ones. Same rule, different bracket. */
const NON_FILTER_LIST_KEYS = ['distinct', 'by'];

export function stripNonFilterBlocks(args: string): string {
  let out = args;
  for (const key of NON_FILTER_LIST_KEYS) {
    out = out.replace(new RegExp(`\\b${key}\\s*:\\s*\\[[^\\]]*\\]`, 'g'), '');
  }
  for (const key of NON_FILTER_KEYS) {
    const re = new RegExp(`\\b${key}\\s*:\\s*\\{`, 'g');
    let m: RegExpExecArray | null;
    // Rebuilt each pass because every removal shifts the offsets after it.
    while ((m = re.exec(out)) !== null) {
      const open = out.indexOf('{', m.index);
      let depth = 0;
      let end = -1;
      for (let i = open; i < out.length; i++) {
        if (out[i] === '{') depth++;
        else if (out[i] === '}') {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) break; // unbalanced — leave it alone rather than mangle it
      out = out.slice(0, m.index) + out.slice(end + 1);
      re.lastIndex = 0;
    }
  }
  return out;
}

/**
 * The one filter that scopes as tightly as a workspaceId: an unguessable,
 * globally-unique public token.
 *
 * The spec header already sanctions this pattern in prose — the public
 * e-signature and invoice flows resolve a row from `findUnique(publicToken)` and
 * carry the workspaceId off that row — and two exemptions below are written for
 * exactly it. Recognising it here rather than exempting each file is what keeps
 * the net tight: `booking.service.ts` has eleven `booking.findFirst` calls, two
 * of them token-keyed self-service entry points and nine of them properly
 * workspace-scoped, so a file-level exemption would buy the two by giving up the
 * nine.
 *
 * Safe because it is checked, not assumed: every `token` and `publicToken`
 * column in schema.prisma is `@unique`, so such a filter can address at most one
 * row and a caller cannot enumerate rows they were not handed the token for. A
 * NULL comparison is deliberately excluded — Postgres allows many NULLs in a
 * unique index, so `publicToken: null` really would span workspaces.
 */
const TOKEN_SCOPE_RE = /\b(?:token|publicToken)\s*[:,}]/;
const TOKEN_IS_NULL_RE = /\b(?:token|publicToken)\s*:\s*null\b/;

export function hasPublicTokenScope(args: string): boolean {
  return TOKEN_SCOPE_RE.test(args) && !TOKEN_IS_NULL_RE.test(args);
}

describe('workspace scoping — the public-token scope', () => {
  it('accepts a lookup keyed by an unguessable unique token', () => {
    expect(hasPublicTokenScope('({ where: { token }, select: { id: true } })')).toBe(true);
    expect(hasPublicTokenScope('({ where: { publicToken: t } })')).toBe(true);
  });

  it('does not mistake a sealed credential column for a public token', () => {
    expect(hasPublicTokenScope('({ where: { accessToken: { not: null } } })')).toBe(false);
    expect(hasPublicTokenScope('({ where: { tokenHash: h } })')).toBe(false);
    expect(hasPublicTokenScope('({ where: { refreshToken: { not: null } } })')).toBe(false);
  });

  it('does not accept a NULL token — a unique index allows many of those', () => {
    expect(hasPublicTokenScope('({ where: { publicToken: null } })')).toBe(false);
  });
});

describe('workspace scoping — the projection hole', () => {
  it('does not count a workspaceId that only appears in a select', () => {
    const args = '({ where: { enabled: true }, select: { id: true, workspaceId: true } })';
    expect(args.includes('workspaceId')).toBe(true); // what the old check saw
    expect(stripNonFilterBlocks(args).includes('workspaceId')).toBe(false);
  });

  it('does not count a workspaceId that only appears in an orderBy or include', () => {
    expect(
      stripNonFilterBlocks('({ where: { a: 1 }, orderBy: { workspaceId: "asc" } })').includes('workspaceId'),
    ).toBe(false);
    expect(
      stripNonFilterBlocks('({ where: { a: 1 }, include: { workspace: { select: { workspaceId: true } } } })').includes(
        'workspaceId',
      ),
    ).toBe(false);
  });

  it('does not count a workspaceId that only appears in a distinct or a groupBy `by`', () => {
    // The array-bracket version of the same hole, and the one the CDR-sync cron
    // walked through: de-duplicating BY a column says nothing about which rows
    // were read in the first place.
    const distinct = "({ where: { type: 'SMS' }, select: { workspaceId: true }, distinct: ['workspaceId'] })";
    expect(distinct.includes('workspaceId')).toBe(true); // what the old check saw
    expect(stripNonFilterBlocks(distinct).includes('workspaceId')).toBe(false);
    expect(
      stripNonFilterBlocks("({ by: ['workspaceId'], _sum: { amount: true } })").includes('workspaceId'),
    ).toBe(false);
  });

  it('still counts a real filter, including one that also projects the column', () => {
    expect(
      stripNonFilterBlocks('({ where: { workspaceId }, select: { id: true } })').includes('workspaceId'),
    ).toBe(true);
    expect(
      stripNonFilterBlocks('({ where: { workspaceId, enabled: true }, select: { workspaceId: true } })').includes(
        'workspaceId',
      ),
    ).toBe(true);
    // A grouped aggregate that IS scoped keeps its filter: only the `by` goes.
    expect(
      stripNonFilterBlocks("({ by: ['workspaceId'], where: { workspaceId } })").includes('workspaceId'),
    ).toBe(true);
  });
});

/**
 * One scan of the module for unscoped calls on workspace-owned delegates.
 *
 * `offenders` are the ones nothing excuses. `silenced` records, per
 * file-scoped exemption key, the call sites that exemption actually
 * suppressed — which is what makes an over-broad key visible.
 */
function scanUnscopedCalls(): { offenders: string[]; silenced: Record<string, string[]> } {
  const delegates = OWNED_DELEGATES.join('|');
  const methods = SCOPED_METHODS.join('|');
  const callRe = new RegExp(`\\.(${delegates})\\.(${methods})\\s*\\(`, 'g');

  const offenders: string[] = [];
  const silenced: Record<string, string[]> = {};
  for (const file of walkTs(MODULE_DIR)) {
    const rel = path.relative(MODULE_DIR, file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src)) !== null) {
      const [, delegate, method] = m;
      const key = `${rel}:${delegate}.${method}`;
      const parentKey = `parent-scoped:${delegate}.${method}`;
      if (ALLOWED_GLOBAL[parentKey]) continue;

      // Projections and sorts stripped first — naming the column is not
      // filtering on it. See stripNonFilterBlocks.
      const args = stripNonFilterBlocks(sliceArgs(src, callRe.lastIndex - 1));
      if (args.includes('workspaceId') || hasPublicTokenScope(args)) continue;

      const line = src.slice(0, m.index).split('\n').length;
      // A file-scoped exemption is applied HERE, after the shape test, so
      // that what it silenced can be counted. A scoped sibling in the same
      // file never reaches this point, and so never spends the budget.
      if (ALLOWED_GLOBAL[key]) {
        (silenced[key] ??= []).push(`${rel}:${line}`);
        continue;
      }
      offenders.push(`${rel}:${line} ${delegate}.${method}(...) has no workspaceId`);
    }
  }
  return { offenders, silenced };
}

describe('workspace scoping — multi-tenant isolation (architecture fitness)', () => {
  it('every multi-row/create Prisma call on a workspace-owned delegate carries workspaceId', () => {
    expect(scanUnscopedCalls().offenders).toEqual([]);
  });

  it('exemptions are pinned to the number of call sites they were written for', () => {
    // The hole this closes: `telephony/call-cdr-sync.service.ts:channel.findMany`
    // was written for ONE global cron read, but the key names a file and a
    // delegate — so it also covered getCreds()'s scoped sibling in the same
    // file, which returns SEALED NetGSM credentials. Deleting `workspaceId`
    // from that where used to pass. Now it makes the count 2 and fails here.
    const { silenced } = scanUnscopedCalls();
    const over: string[] = [];
    for (const [key, sites] of Object.entries(silenced)) {
      const allowed = ALLOWED_GLOBAL_SITES[key] ?? 1;
      if (sites.length > allowed) {
        over.push(`${key} silences ${sites.length} call sites (allowed ${allowed}): ${sites.join(', ')}`);
      }
    }
    expect(over).toEqual([]);
  });

  it('every exemption silences something (no entry kept for a call that is now scoped)', () => {
    // The other direction: a call site that was fixed to carry workspaceId
    // leaves a dead exemption behind, which then sits there ready to excuse
    // a future regression at the same delegate. The staleness test below
    // only asks whether the call still EXISTS; this asks whether it is
    // still global.
    const { silenced } = scanUnscopedCalls();
    const unused = Object.keys(ALLOWED_GLOBAL).filter(
      (key) => !key.startsWith('parent-scoped:') && !silenced[key],
    );
    expect(unused).toEqual([]);
  });

  it('ALLOWED_GLOBAL entries still exist in the code (no stale exemptions)', () => {
    const stale: string[] = [];
    for (const key of Object.keys(ALLOWED_GLOBAL)) {
      if (key.startsWith('parent-scoped:')) continue;
      const [rel, call] = key.split(':');
      const file = path.join(MODULE_DIR, rel);
      if (!fs.existsSync(file)) {
        stale.push(`${key} — file missing`);
        continue;
      }
      const [delegate, method] = call.split('.');
      const src = fs.readFileSync(file, 'utf8');
      if (!new RegExp(`\\.${delegate}\\.${method}\\s*\\(`).test(src)) {
        stale.push(`${key} — call site gone`);
      }
    }
    expect(stale).toEqual([]);
  });
});
