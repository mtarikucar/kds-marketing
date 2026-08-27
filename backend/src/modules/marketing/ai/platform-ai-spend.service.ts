import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { usdFor } from './ai-model-prices';

/**
 * Monthly vendor ceiling for UNLIMITED-PLAN workspaces only, in USD.
 *
 * A metered plan cannot overspend: `AiCreditsService.reserve` throws
 * AI_CREDITS_EXHAUSTED at `aiCreditsMonthly`, and anything beyond that comes
 * out of prepaid credits the customer already bought. seed-packages.ts sizes
 * those allowances at 8-15% of each package's price on purpose, so a paying
 * customer's AI cost is bounded by design and self-funding.
 *
 * `aiCreditsMonthly: -1` is the only hole, and today it belongs to OPERATOR —
 * priced at 0. Unlimited spend against zero revenue: that is our own internal
 * marketing, and it is the entire unbounded surface.
 *
 * So this cap deliberately scopes to unlimited plans. Counting paying tenants
 * against it would be worse than useless: their spend is already bounded, and
 * a growing customer base would eventually trip a ceiling that then halts OUR
 * work as a punishment for their success.
 *
 * $50 default against measured internal use of roughly $5/month — enough
 * headroom to never fire in normal operation, tight enough that a runaway
 * nightly fan-out (~$30/night at the old unbounded settings) is stopped in a
 * day or two rather than at the end of a billing month. 0 disables it.
 */
const CAP_USD = Number(process.env.AI_PLATFORM_MONTHLY_USD_CAP ?? 50);

/**
 * What ONE workspace may spend on unattended AI in a month, in real vendor USD.
 *
 * The platform cap above protects us in aggregate; nothing protected us from a
 * single workspace, and the per-workspace check that existed asked about
 * CREDITS — which an unlimited plan answers "yes" to forever. So the only brake
 * on one workspace's nightly research was the number of profiles it happened to
 * have: 10 runs a night at roughly $0.25 a run on Sonnet is about $75 a month,
 * from one workspace, silently.
 *
 * Measured on the live workspace: a quiet day is ~$0.45 and a busy stretch ran
 * ~$2.40/day for four days — 60% of a month's spend in four days. The average
 * was never the problem; the peak was.
 */
const WORKSPACE_CAP_USD = Number(process.env.AI_WORKSPACE_MONTHLY_USD_CAP ?? 20);

/** Where the alerting steps up. Ratios of the cap. */
export const WARN_AT = 0.5;
export const CRITICAL_AT = 0.8;

export type SpendState = 'DISABLED' | 'OK' | 'WARN' | 'CRITICAL' | 'EXCEEDED';

export interface PlatformSpendStatus {
  capUsd: number;
  spentUsd: number;
  /** Spend ÷ cap. Null when no cap is configured. */
  ratio: number | null;
  state: SpendState;
  /** UTC month the figure covers, `YYYY-MM`. */
  period: string;
  /** True while unattended work should stand down. */
  backgroundBlocked: boolean;
}

/**
 * The ceiling nobody had.
 *
 * Every existing guard asks whether the CUSTOMER has allowance left:
 * `AiCreditsService.reserve` against `aiCreditsMonthly`, and the research
 * cron's `hasBackgroundHeadroom`. Both are right, and both are silent on an
 * unlimited plan — `limit === -1` returns true forever. So the only thing with
 * no bound at all was the number that actually gets billed to us, which is why
 * the vendor balance emptied without a single warning anywhere in the product.
 *
 * This is deliberately asymmetric. Crossing the cap stops the UNATTENDED lane —
 * the nightly research cron, work nobody asked for today — and leaves
 * interactive AI running. A customer who clicks a button and gets refused
 * because of OUR budget has been failed twice; the operator alert is the right
 * response there, not a broken product.
 */
@Injectable()
export class PlatformAiSpendService {
  private readonly logger = new Logger(PlatformAiSpendService.name);

  constructor(private readonly prisma: PrismaService) {}

  static monthStart(now = new Date()): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  /**
   * Workspaces whose plan grants unlimited AI — the only ones this ceiling is
   * about. Read fresh each check: it changes when a package is reassigned,
   * which is rare, and a stale allow-list here would either over-block a
   * customer or under-protect us.
   */
  async unlimitedWorkspaceIds(): Promise<string[]> {
    const subs = await this.prisma.workspaceSubscription.findMany({
      where: { status: { in: ['ACTIVE', 'TRIALING'] } },
      select: { workspaceId: true, packageId: true },
    });
    if (subs.length === 0) return [];
    const packages = await this.prisma.package.findMany({
      where: { id: { in: [...new Set(subs.map((s) => s.packageId))] } },
      select: { id: true, limits: true },
    });
    const unlimited = new Set(
      packages
        .filter((p) => (p.limits as { aiCreditsMonthly?: number } | null)?.aiCreditsMonthly === -1)
        .map((p) => p.id),
    );
    return subs.filter((s) => unlimited.has(s.packageId)).map((s) => s.workspaceId);
  }

  /** Vendor spend this UTC month by unlimited-plan workspaces. */
  async monthToDateUsd(now = new Date()): Promise<number> {
    const workspaceIds = await this.unlimitedWorkspaceIds();
    if (workspaceIds.length === 0) return 0;
    const rows = await this.prisma.aiUsageLog.groupBy({
      by: ['model'],
      where: {
        createdAt: { gte: PlatformAiSpendService.monthStart(now) },
        workspaceId: { in: workspaceIds },
      },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheWriteTokens: true,
        cacheReadTokens: true,
      },
    });
    const usd = rows.reduce(
      (total, r) =>
        total +
        usdFor(r.model, {
          inputTokens: r._sum.inputTokens ?? 0,
          outputTokens: r._sum.outputTokens ?? 0,
          cacheWriteTokens: r._sum.cacheWriteTokens ?? 0,
          cacheReadTokens: r._sum.cacheReadTokens ?? 0,
        }),
      0,
    );
    return Math.round(usd * 100) / 100;
  }

  async status(now = new Date()): Promise<PlatformSpendStatus> {
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const spentUsd = await this.monthToDateUsd(now);

    if (!Number.isFinite(CAP_USD) || CAP_USD <= 0) {
      return {
        capUsd: 0,
        spentUsd,
        ratio: null,
        state: 'DISABLED',
        period,
        backgroundBlocked: false,
      };
    }

    const ratio = Math.round((spentUsd / CAP_USD) * 1000) / 1000;
    const state: SpendState =
      // EXCEEDED compares the money, not the rounded ratio — $49.99 of a $50 cap
      // rounds to 1.000 and would suspend unattended work a cent early. WARN and
      // CRITICAL are advisory thresholds where a rounded ratio is fine.
      spentUsd >= CAP_USD
        ? 'EXCEEDED'
        : ratio >= CRITICAL_AT
          ? 'CRITICAL'
          : ratio >= WARN_AT
            ? 'WARN'
            : 'OK';

    return {
      capUsd: CAP_USD,
      spentUsd,
      ratio,
      state,
      period,
      // Only the unattended lane stands down. See the class comment.
      backgroundBlocked: state === 'EXCEEDED',
    };
  }

  /**
   * May unattended work start? Fails OPEN on an error: a metering hiccup must
   * not silently stop every customer's research, and the alerting below is
   * what catches a genuine overrun.
   */
  /**
   * One workspace's real vendor spend this calendar month.
   *
   * Same pricing path as the platform figure — grouped by model so each is
   * priced at its own rate, and cache reads/writes counted at their multipliers
   * — just scoped to a single workspace and NOT restricted to unlimited plans.
   * A metered plan already has its own credit ceiling; this is about money.
   */
  async workspaceMonthToDateUsd(workspaceId: string, now = new Date()): Promise<number> {
    const rows = await this.prisma.aiUsageLog.groupBy({
      by: ['model'],
      where: {
        workspaceId,
        createdAt: { gte: PlatformAiSpendService.monthStart(now) },
      },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheWriteTokens: true,
        cacheReadTokens: true,
      },
    });
    return rows.reduce(
      (total, r) =>
        total +
        usdFor(r.model, {
          inputTokens: r._sum.inputTokens ?? 0,
          outputTokens: r._sum.outputTokens ?? 0,
          cacheWriteTokens: r._sum.cacheWriteTokens ?? 0,
          cacheReadTokens: r._sum.cacheReadTokens ?? 0,
        }),
      0,
    );
  }

  /** Spend, cap and remaining budget for one workspace this month. */
  async workspaceStatus(
    workspaceId: string,
    now = new Date(),
  ): Promise<{ capUsd: number; spentUsd: number; ratio: number | null; overCap: boolean }> {
    const spentUsd = Math.round((await this.workspaceMonthToDateUsd(workspaceId, now)) * 100) / 100;
    if (!Number.isFinite(WORKSPACE_CAP_USD) || WORKSPACE_CAP_USD <= 0) {
      return { capUsd: 0, spentUsd, ratio: null, overCap: false };
    }
    const ratio = Math.round((spentUsd / WORKSPACE_CAP_USD) * 1000) / 1000;
    // The DECISION compares the money, not the rounded ratio. $19.99 of a $20
    // budget rounds to a ratio of 1.000 and would suspend a workspace that is
    // still inside its budget — a display value must never decide a gate.
    return { capUsd: WORKSPACE_CAP_USD, spentUsd, ratio, overCap: spentUsd >= WORKSPACE_CAP_USD };
  }

  /**
   * May this workspace start MORE unattended AI work this month?
   *
   * Background only, deliberately — the same line the platform cap draws. A
   * customer waiting on a reply must not be cut off because a research run
   * spent the budget; research is the discretionary half.
   *
   * Fails OPEN on error: a metering hiccup must not silently stop research for
   * a workspace that is well inside its budget.
   */
  async mayWorkspaceRunBackground(workspaceId: string): Promise<boolean> {
    try {
      const s = await this.workspaceStatus(workspaceId);
      if (s.overCap) {
        this.logger.warn(
          `workspace ${workspaceId} is over its monthly AI budget ` +
            `($${s.spentUsd} of $${s.capUsd}) — unattended AI suspended for the rest of the month. ` +
            `Raise AI_WORKSPACE_MONTHLY_USD_CAP or wait for the month to roll.`,
        );
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(
        `workspace budget check failed for ${workspaceId}: ${(e as Error)?.message ?? e}`,
      );
      return true;
    }
  }

  async mayRunBackground(): Promise<boolean> {
    try {
      const s = await this.status();
      if (s.backgroundBlocked) {
        this.logger.error(
          `PLATFORM AI CAP EXCEEDED: $${s.spentUsd} of $${s.capUsd} this ${s.period} — ` +
            `unattended AI work is suspended. Interactive AI is unaffected. ` +
            `Raise AI_PLATFORM_MONTHLY_USD_CAP or wait for the month to roll.`,
        );
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(`platform AI cap check failed, allowing: ${(e as Error)?.message ?? e}`);
      return true;
    }
  }
}
