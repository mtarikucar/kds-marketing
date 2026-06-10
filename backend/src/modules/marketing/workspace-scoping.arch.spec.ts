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
  // P6 (GoHighLevel parity): reviews/reputation.
  'reviewSource',
  'review',
] as const;

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
  'scheduling/scheduled-job-runner.service.ts:scheduledJob.updateMany':
    'stuck-reaper resets RUNNING rows across all workspaces (crash recovery sweeper)',
  // Inbound public webhooks have NO workspace context — the provider only
  // gives a widget key or a page/phone id. These two lookups (the ONLY
  // cross-workspace channel/message access) live in one resolver so the
  // exemption surface is a single auditable file; both key on globally-unique
  // handles ((type, externalId) the workspace registered; externalMessageId
  // the provider minted) so they can't leak across tenants.
  'channels/public-channel-resolver.service.ts:channel.findFirst':
    'meta webhook resolves the channel by its provider page/phone id before any workspace context exists',
  'channels/public-channel-resolver.service.ts:message.updateMany':
    'netgsm DLR flips an outbound message status by its globally-unique provider job id',
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
