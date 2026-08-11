import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../../common/scheduling/advisory-lock';
import { AnthropicService } from '../../ai/anthropic.service';
import { ResearchSourcesService } from '../../research/providers/research-sources.service';
import { StrategyFeedbackService } from './strategy-feedback.service';

/**
 * Weekly Strategy feedback tick. For every ACTIVE MarketingStrategy that has
 * something new to learn from, it folds the plan's execution outcomes back
 * into a re-synthesis (version bump + refreshed ActionPlan) via
 * StrategyFeedbackService. Single-replica via advisory lock
 * ('strategy:feedback'); inert when AI or research sources are unconfigured
 * (the re-synthesis would only skip), and self-gating (no ACTIVE strategies →
 * no work), so it stays dormant until a workspace synthesizes a strategy.
 *
 * WHY WEEKLY, AND WHY GATED. This ran DAILY over every ACTIVE strategy with no
 * further condition, and a re-synthesis is the most expensive action in the
 * product — a multi-step Opus tool-loop over live research. Measured against
 * the repriced cost table it was the single largest line in a typical
 * workspace's monthly COGS, and it accrued whether or not anyone was using the
 * product: an abandoned workspace re-synthesized its strategy 30 times a month,
 * unattended, on Jeeta's own vendor accounts.
 *
 * The gate is semantic, not merely a cost lever: feedback exists to fold
 * EXECUTION OUTCOMES back into the plan. If no StrategyAction has changed
 * state since the strategy was last written, there is no new outcome to fold —
 * the re-synthesis would spend real money to reproduce what is already there.
 */
@Injectable()
export class StrategyFeedbackCron {
  private readonly logger = new Logger(StrategyFeedbackCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly feedback: StrategyFeedbackService,
    private readonly sources: ResearchSourcesService,
    private readonly anthropic: AnthropicService,
  ) {}

  @Cron(CronExpression.EVERY_WEEK, { name: 'strategy-feedback-tick' })
  async tick(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'strategy:feedback',
      async () => {
        await this.runAll();
      },
      this.logger,
    );
  }

  /** Refresh every ACTIVE strategy that has new execution outcomes. */
  async runAll(): Promise<number> {
    // Inert unless the strategist brain can actually run — no source money spent,
    // no pointless scans while the feature is unconfigured.
    if (!this.sources.isEnabled() || !this.anthropic.isEnabled()) return 0;

    const strategies = await this.prisma.marketingStrategy.findMany({
      where: { status: 'ACTIVE' },
      select: { workspaceId: true, updatedAt: true },
      take: 500,
    });

    let refreshed = 0;
    let skipped = 0;
    for (const s of strategies) {
      // Only re-synthesize when the plan has actually moved since it was last
      // written. `updatedAt` is bumped by the re-synthesis itself, so this
      // compares against the strategy as we last left it — an idle workspace
      // converges to zero work instead of billing every tick.
      const moved = await this.prisma.strategyAction.findFirst({
        where: { workspaceId: s.workspaceId, updatedAt: { gt: s.updatedAt } },
        select: { id: true },
      });
      if (!moved) {
        skipped++;
        continue;
      }
      try {
        await this.feedback.refresh(s.workspaceId);
        refreshed++;
      } catch (e) {
        this.logger.error(`strategy-feedback refresh failed for ws ${s.workspaceId}: ${(e as Error)?.message ?? e}`);
      }
    }
    if (refreshed > 0 || skipped > 0) {
      this.logger.log(
        `strategy-feedback: refreshed ${refreshed}, skipped ${skipped} unchanged, of ${strategies.length} active strategy(ies)`,
      );
    }
    return refreshed;
  }
}
