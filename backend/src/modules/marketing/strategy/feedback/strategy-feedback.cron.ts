import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../../common/scheduling/advisory-lock';
import { AnthropicService } from '../../ai/anthropic.service';
import { ResearchSourcesService } from '../../research/providers/research-sources.service';
import { StrategyFeedbackService } from './strategy-feedback.service';

/**
 * Daily Strategy feedback tick. For every ACTIVE MarketingStrategy it folds the
 * plan's execution outcomes back into a re-synthesis (version bump + refreshed
 * ActionPlan) via StrategyFeedbackService. Single-replica via advisory lock
 * ('strategy:feedback'); inert when AI or research sources are unconfigured (the
 * re-synthesis would only skip), and self-gating (no ACTIVE strategies → no
 * work), so it stays dormant until a workspace synthesizes a strategy.
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

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'strategy-feedback-tick' })
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

  /** Refresh every ACTIVE strategy. Isolated for testability. */
  async runAll(): Promise<number> {
    // Inert unless the strategist brain can actually run — no source money spent,
    // no pointless scans while the feature is unconfigured.
    if (!this.sources.isEnabled() || !this.anthropic.isEnabled()) return 0;

    const strategies = await this.prisma.marketingStrategy.findMany({
      where: { status: 'ACTIVE' },
      select: { workspaceId: true },
      take: 500,
    });

    let refreshed = 0;
    for (const s of strategies) {
      try {
        await this.feedback.refresh(s.workspaceId);
        refreshed++;
      } catch (e) {
        this.logger.error(`strategy-feedback refresh failed for ws ${s.workspaceId}: ${(e as Error)?.message ?? e}`);
      }
    }
    if (refreshed > 0) this.logger.log(`strategy-feedback: refreshed ${refreshed}/${strategies.length} active strategy(ies)`);
    return refreshed;
  }
}
