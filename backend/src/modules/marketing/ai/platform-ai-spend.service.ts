import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { usdFor } from './ai-model-prices';

/**
 * Jeeta's OWN monthly vendor ceiling, in USD. Not a customer allowance — this
 * is the Anthropic bill. Set AI_PLATFORM_MONTHLY_USD_CAP to change it; 0 or a
 * negative value disables the ceiling (and the guard says so out loud rather
 * than pretending to protect anything).
 */
const CAP_USD = Number(process.env.AI_PLATFORM_MONTHLY_USD_CAP ?? 250);

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

  /** Real vendor spend so far this UTC month, across every workspace. */
  async monthToDateUsd(now = new Date()): Promise<number> {
    const rows = await this.prisma.aiUsageLog.groupBy({
      by: ['model'],
      where: { createdAt: { gte: PlatformAiSpendService.monthStart(now) } },
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
      ratio >= 1 ? 'EXCEEDED' : ratio >= CRITICAL_AT ? 'CRITICAL' : ratio >= WARN_AT ? 'WARN' : 'OK';

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
