import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { IysClient, IysConsentRow, IysConsentType } from '../../netgsm/iys/iys.client';

export type IysConsentDirection = 'ONAY' | 'RET';

export interface IysConsentEnqueueParams {
  workspaceId: string;
  leadId: string;
  /** Lead's phone. Absent/null → nothing to prove to İYS, so this is a no-op. */
  recipient: string | null | undefined;
  direction: IysConsentDirection;
  /** İYS source code (e.g. `HS_WEB` / `HS_MESAJ`) — the PRODUCER decides this
   *  (it knows whether the consent came from the dashboard, a public
   *  unsubscribe link, etc.); this service stays source-agnostic. */
  source: string;
  consentAt?: Date;
}

/** The minimal IysSyncJob-row shape the worker needs. */
interface PendingJob {
  id: string;
  workspaceId: string;
  recipient: string;
  type: string;
  direction: string;
  consentAt: Date;
  source: string | null;
  attempts: number;
  updatedAt: Date;
}

/** İYS's documented per-call cap (mirrors IysClient.add's own defensive guard). */
const IYS_ADD_MAX_ROWS = 500;
/** İYS's documented per-account rate limit for `/iys/add`. */
const IYS_BUDGET_LIMIT = 10;
const IYS_BUDGET_WINDOW_MS = 60_000;
/** FAILED → DLQ once a row has failed this many times (any failure reason —
 *  a transient NetGSM error or a standing workspace-config gap alike). */
const DLQ_THRESHOLD_ATTEMPTS = 8;
/** Backoff schedule: 1m, 2m, 4m, 8m, 16m, 32m, capped at 1h. */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 3_600_000;
/** Bound on how many due rows one tick will look at, across every workspace —
 *  a generous multiple of the 500-row add() cap so one very busy workspace
 *  can never starve another's turn in the same tick (mirrors
 *  NetgsmDlrPollService's per-tick candidate cap philosophy). */
const MAX_CANDIDATES_PER_TICK = 5_000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Format a Date as İYS's `YYYY-MM-DD HH:mm:ss` in Turkey local time (fixed
 *  UTC+3 — TR has observed no DST since 2016) — same fixed-offset idiom as
 *  `CallCdrSyncService`/`NetgsmMoPollService`'s private `fmtTr` helpers,
 *  duplicated here (not imported) because those are file-scope private
 *  functions in unrelated services and İYS wants a different string shape
 *  (`YYYY-MM-DD HH:mm:ss`, not NetGSM's bare `ddMMyyyyHHmm`). */
function fmtIysDate(d: Date): string {
  const t = new Date(d.getTime() + 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/**
 * İYS (İleti Yönetim Sistemi) auto-push — Phase 2 Task 3.
 *
 * Two responsibilities, one file (per the plan):
 *
 * 1. `enqueueConsent` — called by `ComplianceService.recordConsent` (MARKETING_SMS
 *    branch) and `CampaignTrackingService`'s public unsubscribe route, from
 *    INSIDE those callers' own `$transaction` (same savepoint idiom they already
 *    use for the NetGSM blacklist-sync outbox mirror) so the İYS proof-of-consent
 *    row is written atomically with the underlying `smsOptOut` flip, yet a
 *    failure to enqueue can never abort that flip. ONLY `MARKETING_SMS` consent
 *    maps to İYS in this phase (`type: 'MESAJ'`) — `ARAMA` (call consent) lands
 *    with Phase 5's voice campaigns; this is a deliberate YAGNI deferral, not an
 *    oversight.
 *
 * 2. A 1-minute advisory-locked cron worker that drains due `IysSyncJob` rows
 *    (`status` PENDING fresh, or FAILED retried with backoff — see the model's
 *    own doc-comment for the full state machine) grouped by workspace, resolves
 *    each workspace's NetGSM İYS credentials (usercode/password from the ACTIVE
 *    SMS channel's sealed secrets + `brandCode` from that same channel's
 *    `configPublic` — Task 6 lands the settings-card UI for it), chunks ≤500,
 *    spends one `AccountRateBudgeter` `iys` budget unit (10/min/account) per
 *    `IysClient.add` call, and stamps the outcome back onto each row. A budget
 *    denial simply stops that workspace's batches for this tick — the rows are
 *    untouched and picked up again next tick. Every other failure (missing
 *    creds/brandCode, a NetGSM add() error, OR an `ok:true` response whose
 *    `refids` array is shorter than the batch — `IysClient`'s refid
 *    extraction drops any row whose refid key it didn't recognize, which
 *    would otherwise shift every later row's stamped refid out of alignment)
 *    increments `attempts` + records `lastError`, applying an exponential
 *    backoff (1m→2m→4m→…capped at 1h) before the row is eligible again, and
 *    escalates to a terminal `DLQ` after 8 attempts (surfaced as a warning
 *    badge + a manager retry endpoint — `ComplianceController`'s
 *    `POST /marketing/compliance/iys/retry`). A row is ONLY ever stamped
 *    `SENT` when the batch's `refids` count matches exactly — never on a
 *    guess — so a consent proof can never be silently and permanently
 *    misattributed or dropped.
 *
 * The worker never throws out of a tick: a bad workspace/account is caught and
 * logged so it can never stall another workspace's turn, and the top-level
 * `drain()` itself never rejects either (mirrors every other cron in this
 * codebase — a scheduler-caught rejection would just spam error logs with no
 * recovery benefit).
 */
@Injectable()
export class IysSyncService {
  private readonly logger = new Logger(IysSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly budgeter: AccountRateBudgeter,
    private readonly client: IysClient,
  ) {}

  /** Enqueue one İYS proof-of-consent job. Must be called with the SAME `tx`
   *  the caller's own flip/outbox-append transaction uses — this never opens
   *  its own transaction, so the caller stays in full control of atomicity
   *  and rollback scope (wrap this call in its own SAVEPOINT if it must never
   *  be able to unwind anything else in that transaction, exactly like
   *  `ComplianceService`/`CampaignTrackingService` do). */
  async enqueueConsent(tx: Prisma.TransactionClient, params: IysConsentEnqueueParams): Promise<void> {
    if (!params.recipient) return; // no phone -> nothing to prove to İYS
    await tx.iysSyncJob.create({
      data: {
        workspaceId: params.workspaceId,
        leadId: params.leadId,
        recipient: params.recipient,
        type: 'MESAJ', // ONLY MARKETING_SMS→MESAJ this phase — see class docstring.
        direction: params.direction,
        consentAt: params.consentAt ?? new Date(),
        source: params.source,
      },
    });
  }

  /** Manager-triggered reset: DLQ → PENDING, attempts=0, lastError cleared —
   *  scoped to ONE workspace (never a cross-tenant reset). Called from
   *  `POST /marketing/compliance/iys/retry`. */
  async retryDlq(workspaceId: string): Promise<{ count: number }> {
    const result = await this.prisma.iysSyncJob.updateMany({
      where: { workspaceId, status: 'DLQ' },
      data: { status: 'PENDING', attempts: 0, lastError: null },
    });
    return { count: result.count };
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'iys-sync' })
  async drainDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'iys-sync',
      async () => {
        await this.drain();
      },
      this.logger,
    );
  }

  /** One tick. Public (not just cron-invoked) so tests can call it directly. */
  async drain(): Promise<{ processed: number; sent: number }> {
    let processed = 0;
    let sent = 0;
    try {
      // FAILED rows are re-picked (subject to backoff below) — only DLQ and
      // the terminal SENT/CONFIRMED states are excluded.
      const candidates = await this.prisma.iysSyncJob.findMany({
        where: { status: { in: ['PENDING', 'FAILED'] } },
        orderBy: { createdAt: 'asc' },
        take: MAX_CANDIDATES_PER_TICK,
      });
      if (candidates.length === 0) return { processed, sent };

      const now = Date.now();
      const eligible = candidates.filter((j) => this.isEligible(j.attempts, j.updatedAt, now));
      if (eligible.length === 0) return { processed, sent };

      const byWorkspace = new Map<string, PendingJob[]>();
      for (const j of eligible as PendingJob[]) {
        const list = byWorkspace.get(j.workspaceId);
        if (list) list.push(j);
        else byWorkspace.set(j.workspaceId, [j]);
      }

      for (const [workspaceId, jobs] of byWorkspace) {
        try {
          const r = await this.drainWorkspace(workspaceId, jobs);
          processed += r.processed;
          sent += r.sent;
        } catch (e: any) {
          this.logger.warn(`iys-sync: workspace ${workspaceId} tick failed: ${e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`iys-sync: tick failed: ${e?.message ?? e}`);
    }
    return { processed, sent };
  }

  private async drainWorkspace(
    workspaceId: string,
    jobs: PendingJob[],
  ): Promise<{ processed: number; sent: number }> {
    const creds = await this.resolveCreds(workspaceId);
    if (creds.reason) {
      await this.markFailedBatch(jobs, creds.reason);
      return { processed: 0, sent: 0 };
    }

    let processed = 0;
    let sent = 0;
    for (const batch of chunk(jobs, IYS_ADD_MAX_ROWS)) {
      if (!this.budgeter.tryTake(creds.usercode, 'iys', IYS_BUDGET_LIMIT, IYS_BUDGET_WINDOW_MS)) {
        break; // account budget exhausted this minute — remaining batches resume next tick, untouched
      }
      processed += batch.length;
      const result = await this.client.add(
        { usercode: creds.usercode, password: creds.password, brandCode: creds.brandCode },
        batch.map((j) => this.toWireRow(j)),
      );
      if (result.ok && result.refids.length === batch.length) {
        await this.markSent(batch, result.refids);
        sent += batch.length;
      } else if (result.ok) {
        // `extractRefids` DROPS (not nulls-out) any row whose refid key didn't
        // match a known alias, so a short `refids` array means every entry
        // AFTER the first drop is misaligned with `batch` — there is no safe
        // way to match by order any more. Fail closed: never stamp SENT on a
        // count mismatch, or some rows would get an ok/null-refid stamp and be
        // silently excluded from re-submission forever (a non-self-healing
        // consent-proof loss, worst for RET/opt-out). Treat it exactly like
        // any other failed attempt so it backs off and escalates to DLQ.
        await this.markFailedBatch(
          batch,
          `refid count mismatch: expected ${batch.length} got ${result.refids.length}`,
        );
      } else {
        await this.markFailedBatch(batch, result.message ?? 'İYS add başarısız');
      }
    }
    return { processed, sent };
  }

  private toWireRow(job: PendingJob): IysConsentRow {
    return {
      recipient: job.recipient,
      type: job.type as IysConsentType,
      status: job.direction as 'ONAY' | 'RET',
      consentDate: fmtIysDate(job.consentAt),
      source: job.source ?? 'HS_WEB',
    };
  }

  /** Success path — refids are matched back to rows BY ORDER (this worker
   *  never resubmits a row that already carries a `refid`, so there is no
   *  correction/dedup case to match by refid instead, in this phase). Only
   *  ever called once the caller has confirmed `refids.length === batch.length`
   *  — a short array is handled as a failed attempt instead (see caller). */
  private async markSent(batch: PendingJob[], refids: string[]): Promise<void> {
    await Promise.all(
      batch.map((job, i) =>
        this.prisma.iysSyncJob.update({
          where: { id: job.id },
          data: { status: 'SENT', refid: refids[i] ?? null },
        }),
      ),
    );
  }

  /** Shared failure path for BOTH "couldn't even attempt" (missing creds/
   *  brandCode) and "NetGSM add() rejected the batch" — the model's state
   *  machine treats every failure reason the same way: FAILED, backed off,
   *  escalating to DLQ after 8 attempts. */
  private async markFailedBatch(batch: PendingJob[], reason: string): Promise<void> {
    await Promise.all(
      batch.map((job) => {
        const attempts = job.attempts + 1;
        const data: Prisma.IysSyncJobUpdateInput =
          attempts >= DLQ_THRESHOLD_ATTEMPTS
            ? { status: 'DLQ', attempts, lastError: reason }
            : { status: 'FAILED', attempts, lastError: reason };
        return this.prisma.iysSyncJob.update({ where: { id: job.id }, data });
      }),
    );
  }

  /** attempts=0 (fresh, never tried) is always eligible; otherwise gated by
   *  an exponential backoff off `updatedAt` (the last attempt's timestamp). */
  private isEligible(attempts: number, updatedAt: Date, now: number): boolean {
    if (attempts <= 0) return true;
    const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
    return now - updatedAt.getTime() >= backoffMs;
  }

  /** Resolve the workspace's İYS credentials: the first ACTIVE SMS channel
   *  carrying usercode+password (mirrors `CallCdrSyncService`/
   *  `NetgsmBlacklistSyncService`'s own `getCreds`), then that SAME channel's
   *  `brandCode` (a raw `configPublic` key today — Task 6 lands the
   *  settings-card UI for it). */
  private async resolveCreds(workspaceId: string): Promise<{
    usercode?: string;
    password?: string;
    brandCode?: string;
    /** Set ONLY on failure — `drainWorkspace` treats a set `reason` as the
     *  discriminant (deliberately NOT a `{ok: boolean}` tagged union: this
     *  file's tsconfig runs with `strictNullChecks: false`, under which a
     *  `!creds.ok` truthiness check does not narrow the following branch's
     *  property types, so a flat optional-fields shape checked via
     *  `if (creds.reason)` is used instead — simpler and unambiguous either
     *  way). */
    reason?: string;
  }> {
    const channels = await this.prisma.channel.findMany({ where: { workspaceId, type: 'SMS', status: 'ACTIVE' } });
    for (const ch of channels) {
      const cfg = this.registry.resolveConfig(ch as any);
      if (cfg.secrets?.usercode && cfg.secrets?.password) {
        const brandCode = typeof cfg.public?.brandCode === 'string' ? cfg.public.brandCode.trim() : '';
        if (!brandCode) return { reason: 'no brandCode' };
        return { usercode: cfg.secrets.usercode, password: cfg.secrets.password, brandCode };
      }
    }
    return { reason: 'no creds' };
  }
}
