import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../../prisma/prisma.service';
import { MailTransport } from './outbound-mail.types';

/** The counter every platform-transport send is written to. */
export const MAIL_DAILY_METRIC = 'mail.platform.daily';

/**
 * The `workspaceId` the PLATFORM-wide row is filed under.
 *
 * `UsageCounter` is keyed by workspace and has no foreign key, so the
 * deployment-wide total lives in the same table as a row nobody owns. It is
 * deliberately not a uuid: it can never collide with a real workspace id, and
 * it is obvious in a query result. **Every per-workspace usage aggregation has
 * to exclude it explicitly**, or an operator sees a phantom tenant whose
 * volume is the sum of everyone else's (`breakdown()` below is the only reader
 * this service ships, and it filters).
 */
export const PLATFORM_SENTINEL = '__platform__';

/** UTC day, house style — the same `toISOString().slice()` shape as `monthKey`. */
export function mailDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** What stopped the send, and when it is worth trying again. */
export interface DailyCapRefusal {
  /** Whose ceiling was hit: this tenant's, or the whole relay's. */
  scope: 'WORKSPACE' | 'PLATFORM';
  limit: number;
  used: number;
  /** Next UTC midnight. A capped mail is QUEUED FORWARD, never dropped. */
  retryAt: Date;
}

export interface DailyBudgetArgs {
  workspaceId: string;
  /** Only `PLATFORM` spends the shared relay's budget. */
  transport: MailTransport;
  count?: number;
  now?: Date;
}

/**
 * The daily budget on the one shared relay.
 *
 * `shared-godaddy-mailbox` (HIGH): a single non-pooled GoDaddy mailbox
 * (`admin@jeetagrowth.com`) carries every tenant's fallback bulk, workflow,
 * transactional and auth mail. Nothing counted it and nothing capped it, so
 * one tenant's blast could trip the relay's own daily limit and take password
 * resets, invoices and booking confirmations down for **every other tenant**
 * for the rest of that day. `no-per-tenant-control` (MEDIUM) is the other half
 * of the same hole: when the relay did throttle, the operator had no way to
 * tell whose blast caused it.
 *
 * ## Two rows per send, and why
 *
 * A per-workspace row answers "whose blast was it" and stops one tenant
 * spending the whole day on its own. A platform row answers "are we near the
 * relay's limit at all", which no sum of per-workspace caps can answer once
 * there is more than one tenant. Both are `UsageCounter` rows on a `YYYY-MM-DD`
 * key — the shape `MessageQuotaService` and the lead-ingest meter already
 * prove, so there is no new table and no new migration.
 *
 * ## Only the platform transport
 *
 * A tenant sending through its OWN verified mailbox is spending its own
 * reputation and its own provider's quota; capping that would be us rationing
 * something we do not pay for. Those sends are not counted at all, which also
 * keeps the platform row honest as a measure of the shared relay.
 *
 * ## Counting is not capping
 *
 * With a cap switched off (`0`) the counters still move. Attribution is the
 * half of `no-per-tenant-control` that is useful on day one, and it must not
 * depend on an operator having picked a number yet.
 *
 * ## Nothing here throws (PLAN G2)
 *
 * A refusal is a value. A counter that will not write is a warning, and the
 * mail goes — a bookkeeping failure must never become an undelivered invoice.
 */
@Injectable()
export class MailBudgetService {
  private readonly logger = new Logger(MailBudgetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The ceilings, per UTC day. `0` (or anything unparseable) switches a cap
   * off and leaves the counter running.
   *
   * The defaults are generous on purpose: the whole deployment's real volume
   * today is a small fraction of either number, so no existing tenant meets
   * one, and they exist so that a runaway loop or a mistakenly enormous
   * campaign cannot spend the shared relay's entire day before anybody
   * notices. The operator narrows them to whatever the relay actually allows
   * (`MAIL_DAILY_CAP_WORKSPACE` / `MAIL_DAILY_CAP_PLATFORM`).
   */
  caps(): { workspace: number; platform: number } {
    return {
      workspace: this.cap('MAIL_DAILY_CAP_WORKSPACE', 1000),
      platform: this.cap('MAIL_DAILY_CAP_PLATFORM', 5000),
    };
  }

  /**
   * Spend one platform-transport send from today's budget.
   *
   * Returns the refusal that stopped it, or `null` when it may go. A refusal
   * spends nothing: neither counter is touched, so a capped campaign that
   * resumes tomorrow starts from where it actually got to.
   */
  async reserveDaily(args: DailyBudgetArgs): Promise<DailyCapRefusal | null> {
    const count = args.count ?? 1;
    if (args.transport !== 'PLATFORM' || count <= 0) return null;
    const now = args.now ?? new Date();
    const periodKey = mailDayKey(now);
    const { workspace: wsCap, platform: platformCap } = this.caps();

    // Nothing can be refused, so nothing needs serializing: two plain
    // increments instead of a transaction and two advisory locks on the hot
    // path of every campaign recipient.
    if (wsCap <= 0 && platformCap <= 0) {
      await this.bump(args.workspaceId, periodKey, count);
      await this.bump(PLATFORM_SENTINEL, periodKey, count);
      return null;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // A FIXED lock order — platform first, then the workspace. Two tenants
        // reserving at the same moment therefore queue behind each other
        // instead of each holding the lock the other wants.
        const platformUsed = await this.lockedRead(tx, PLATFORM_SENTINEL, periodKey);
        if (platformCap > 0 && platformUsed + count > platformCap) {
          return { scope: 'PLATFORM' as const, limit: platformCap, used: platformUsed, retryAt: nextUtcMidnight(now) };
        }
        const wsUsed = await this.lockedRead(tx, args.workspaceId, periodKey);
        if (wsCap > 0 && wsUsed + count > wsCap) {
          return { scope: 'WORKSPACE' as const, limit: wsCap, used: wsUsed, retryAt: nextUtcMidnight(now) };
        }
        await this.bump(args.workspaceId, periodKey, count, tx);
        await this.bump(PLATFORM_SENTINEL, periodKey, count, tx);
        return null;
      });
    } catch (e: any) {
      // The budget is a safety rail, not a gate on the business. If we cannot
      // read it, the mail goes and the operator gets a line about why the
      // number they are looking at is short.
      this.logger.warn(`daily budget reserve failed (workspace=${args.workspaceId}): ${e?.message ?? e}`);
      return null;
    }
  }

  /** Give today's budget back when the send it paid for never left. */
  async refundDaily(args: DailyBudgetArgs): Promise<void> {
    const count = args.count ?? 1;
    if (args.transport !== 'PLATFORM' || count <= 0) return;
    const periodKey = mailDayKey(args.now ?? new Date());
    await this.giveBack(args.workspaceId, periodKey, count);
    await this.giveBack(PLATFORM_SENTINEL, periodKey, count);
  }

  /** One workspace's own day. The platform row is not a tenant's business. */
  async usage(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<{ day: string; limit: number; used: number; remaining: number }> {
    const periodKey = mailDayKey(now);
    const limit = this.caps().workspace;
    const used = await this.read(workspaceId, periodKey);
    return {
      day: periodKey,
      limit,
      used,
      remaining: limit <= 0 ? -1 : Math.max(0, limit - used),
    };
  }

  /**
   * Today's platform-transport volume per tenant, busiest first — the answer
   * to "who caused the throttle". The sentinel is stripped from the input, so
   * a caller that passes every workspace id it has still cannot accidentally
   * render the deployment total as a tenant.
   */
  async breakdown(
    workspaceIds: string[],
    now: Date = new Date(),
  ): Promise<{ workspaceId: string; used: number }[]> {
    const ids = workspaceIds.filter((id) => id && id !== PLATFORM_SENTINEL);
    if (!ids.length) return [];
    const rows = await this.prisma.usageCounter.findMany({
      where: { workspaceId: { in: ids }, metric: MAIL_DAILY_METRIC, periodKey: mailDayKey(now) },
      select: { workspaceId: true, value: true },
    });
    return rows
      .map((r) => ({ workspaceId: r.workspaceId, used: r.value ?? 0 }))
      .sort((a, b) => b.used - a.used || a.workspaceId.localeCompare(b.workspaceId));
  }

  /** The whole deployment's day, for the operator console. */
  async platformUsage(now: Date = new Date()): Promise<{ day: string; limit: number; used: number }> {
    const periodKey = mailDayKey(now);
    return { day: periodKey, limit: this.caps().platform, used: await this.read(PLATFORM_SENTINEL, periodKey) };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private cap(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /**
   * Take the per-key advisory lock and read the counter under it, so two
   * concurrent reserves cannot both see the same value and both pass the cap.
   * `::text` — `pg_advisory_xact_lock` returns void, which Prisma's raw
   * deserializer refuses.
   */
  private async lockedRead(tx: any, workspaceId: string, periodKey: string): Promise<number> {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtext(${escapeLockKey(`mail-daily:${workspaceId}`)}))::text AS locked`,
    );
    const row = await tx.usageCounter.findUnique({
      where: { workspaceId_metric_periodKey: { workspaceId, metric: MAIL_DAILY_METRIC, periodKey } },
      select: { value: true },
    });
    return row?.value ?? 0;
  }

  private async read(workspaceId: string, periodKey: string): Promise<number> {
    const row = await this.prisma.usageCounter.findUnique({
      where: { workspaceId_metric_periodKey: { workspaceId, metric: MAIL_DAILY_METRIC, periodKey } },
      select: { value: true },
    });
    return row?.value ?? 0;
  }

  private async bump(workspaceId: string, periodKey: string, delta: number, tx?: any): Promise<void> {
    const db = tx ?? this.prisma;
    const write = db.usageCounter.upsert({
      where: { workspaceId_metric_periodKey: { workspaceId, metric: MAIL_DAILY_METRIC, periodKey } },
      create: { workspaceId, metric: MAIL_DAILY_METRIC, periodKey, value: Math.max(0, delta) },
      update: { value: { increment: delta } },
    });
    // Inside the transaction a failure must roll the whole reserve back; on the
    // uncapped path there is nothing to roll back and a counter is not worth a
    // failed send.
    if (tx) await write;
    else
      await Promise.resolve(write).catch((e: any) =>
        this.logger.warn(`daily budget count failed (workspace=${workspaceId}): ${e?.message ?? e}`),
      );
  }

  /** Floored decrement — a refund may never drive a counter below zero, or the
   *  remaining budget would overstate itself for the rest of the day. */
  private async giveBack(workspaceId: string, periodKey: string, count: number): Promise<void> {
    try {
      const row = await this.prisma.usageCounter.findUnique({
        where: { workspaceId_metric_periodKey: { workspaceId, metric: MAIL_DAILY_METRIC, periodKey } },
        select: { value: true },
      });
      if (!row) return; // nothing spent today → nothing to give back
      await this.prisma.usageCounter.update({
        where: { workspaceId_metric_periodKey: { workspaceId, metric: MAIL_DAILY_METRIC, periodKey } },
        data: { value: Math.max(0, (row.value ?? 0) - count) },
      });
    } catch (e: any) {
      this.logger.warn(`daily budget refund failed (workspace=${workspaceId}): ${e?.message ?? e}`);
    }
  }
}

/** Next UTC midnight — when today's budget is replaced, not topped up. */
function nextUtcMidnight(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

/** Single-quote a lock key for the raw advisory-lock SELECT. */
function escapeLockKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}
