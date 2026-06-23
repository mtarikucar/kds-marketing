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
 */
const ALLOWED_GLOBAL: Record<string, string> = {
  // Login/refresh resolve identity by globally-unique email/id BEFORE a
  // workspace context exists; registerWorkspace creates the workspace and
  // its first users in the same tx (workspaceId comes from tx-local rows).
  'services/marketing-auth.service.ts:marketingUser.create':
    'registerWorkspace: rows are created with the tx-created workspace id',
  // LeadActivity/InstallationTask are scoped via their parent (leadId/jobId
  // is resolved through a workspace-scoped read in the same service call).
  // Creates that pass a parent id resolved in-scope are tolerated wholesale:
  'parent-scoped:leadActivity.create':
    'activity rows inherit scope from a lead resolved via a scoped read',
  'parent-scoped:leadActivity.createMany':
    'bulk activity rows inherit scope from leads resolved via a scoped findMany (bulkAssign)',
  'parent-scoped:installationTask.create':
    'checklist rows inherit scope from a job resolved via a scoped read',
  'parent-scoped:installationTask.createMany':
    'checklist rows inherit scope from a job resolved via a scoped read',
  'parent-scoped:installationTask.updateMany':
    'mutations are keyed by (id, jobId) with the job resolved via a scoped read',
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
  // Call-recording retrieval sweep (Epic 13, inert): the hourly cron reads ended
  // api-dial calls missing a recording across ALL workspaces — a system job, same
  // shape as the ads/subscription sweeps. The only write it triggers is an
  // id-keyed salesCall.update of recordingUrl; idempotent (re-stamps the same URL).
  'telephony/recording-sync.service.ts:salesCall.findMany':
    'hourly call-recording sweep reads ended calls missing a recording across all workspaces (system cron)',
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
  'parent-scoped:lesson.count':
    'lesson count keyed by a courseId/module resolved via a scoped read',
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
  'parent-scoped:communityMember.upsert':
    'membership keyed by (communityId, leadId) under assertCommunity(workspaceId, …)',
  'parent-scoped:communityMember.deleteMany':
    'leave keyed by (communityId, leadId) under a scoped community read',
  'parent-scoped:communityMember.findMany':
    'roster keyed by a communityId resolved via assertCommunity(workspaceId, …)',
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

describe('workspace scoping — multi-tenant isolation (architecture fitness)', () => {
  it('every multi-row/create Prisma call on a workspace-owned delegate carries workspaceId', () => {
    const delegates = OWNED_DELEGATES.join('|');
    const methods = SCOPED_METHODS.join('|');
    const callRe = new RegExp(
      `\\.(${delegates})\\.(${methods})\\s*\\(`,
      'g',
    );

    const offenders: string[] = [];
    for (const file of walkTs(MODULE_DIR)) {
      const rel = path.relative(MODULE_DIR, file).replace(/\\/g, '/');
      const src = fs.readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src)) !== null) {
        const [, delegate, method] = m;
        const key = `${rel}:${delegate}.${method}`;
        const parentKey = `parent-scoped:${delegate}.${method}`;
        if (ALLOWED_GLOBAL[key] || ALLOWED_GLOBAL[parentKey]) continue;

        const args = sliceArgs(src, callRe.lastIndex - 1);
        if (!args.includes('workspaceId')) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${rel}:${line} ${delegate}.${method}(...) has no workspaceId`);
        }
      }
    }

    expect(offenders).toEqual([]);
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
