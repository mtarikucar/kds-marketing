import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { StrategySynthesisService, StrategySynthesisResult } from '../synthesis/strategy-synthesis.service';

export interface StrategyFeedbackResult extends StrategySynthesisResult {}

/** Prisma Decimal | number | null → a plain number (0 for null/undefined). */
function decToNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const anyV = v as { toNumber?: () => number };
  if (typeof anyV.toNumber === 'function') return anyV.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Strategy living feedback loop — folds a workspace's execution OUTCOMES back
 * into the strategy. `refresh` gathers a compact summary of what the current
 * ActionPlan actually produced (DONE actions by kind, staged research runs /
 * posts / community drops derived from resultRefs, and cheap ad-performance
 * signal from AdMetric) and re-runs the strategist synthesis with that summary
 * as extra context. Synthesis version-bumps `MarketingStrategy` and re-seeds the
 * ActionPlan (and, for an AUTONOMOUS workspace, auto-applies it via the
 * orchestrator hook). Spend/credits are metered inside synthesis (which also
 * self-gates when AI/sources are unconfigured). Idempotent-ish: each refresh is
 * one bounded synthesis run. Workspaces with no ACTIVE strategy are skipped.
 */
@Injectable()
export class StrategyFeedbackService {
  private readonly logger = new Logger(StrategyFeedbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly synthesis: StrategySynthesisService,
  ) {}

  async refresh(workspaceId: string): Promise<StrategyFeedbackResult> {
    const strategy = await this.prisma.marketingStrategy.findFirst({
      where: { workspaceId, status: 'ACTIVE' },
    });
    if (!strategy) {
      this.logger.debug(`feedback: no ACTIVE strategy for ws ${workspaceId} — skipping`);
      return { strategyId: null, actionCount: 0, skipped: 'no-active-strategy' };
    }

    // Re-synthesis reuses the workspace's most recent intake session (its
    // auto-analysis + interview answers) as the base; the outcome summary is
    // layered on top. Without a session there is nothing to re-synthesize from.
    const session = await this.prisma.strategyIntakeSession.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) {
      this.logger.debug(`feedback: no intake session for ws ${workspaceId} — skipping`);
      return { strategyId: null, actionCount: 0, skipped: 'no-intake-session' };
    }

    const summary = await this.buildSummary(workspaceId, strategy.id);
    this.logger.log(`feedback: re-synthesizing strategy for ws ${workspaceId} (v${(strategy as { version?: number }).version ?? '?'})`);
    return this.synthesis.synthesize(workspaceId, session.id, summary);
  }

  /** Gather completed-action + cheap engagement/ad signals into a compact,
   *  strategist-readable text block. */
  private async buildSummary(workspaceId: string, strategyId: string): Promise<string> {
    const done = await this.prisma.strategyAction.findMany({
      where: { workspaceId, strategyId, status: 'DONE' },
      select: { kind: true, resultRef: true },
    });

    const byKind = new Map<string, number>();
    const byRef = { research: 0, post: 0, community: 0, campaign: 0 };
    for (const a of done) {
      byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
      const ref = String(a.resultRef ?? '');
      if (ref.startsWith('research:')) byRef.research += 1;
      else if (ref.startsWith('post:')) byRef.post += 1;
      else if (ref.startsWith('community:')) byRef.community += 1;
      else if (ref.startsWith('campaign:')) byRef.campaign += 1;
    }

    const agg = await this.prisma.adMetric
      .aggregate({ where: { workspaceId }, _sum: { spend: true, revenue: true }, _count: true })
      .catch(() => null);
    const metricDays = typeof (agg as { _count?: unknown })?._count === 'number' ? (agg as { _count: number })._count : 0;
    const spend = decToNum((agg as { _sum?: { spend?: unknown } })?._sum?.spend);
    const revenue = decToNum((agg as { _sum?: { revenue?: unknown } })?._sum?.revenue);
    const roas = spend > 0 ? (revenue / spend).toFixed(2) : 'n/a';

    const kindLine = byKind.size
      ? [...byKind.entries()].map(([k, n]) => `${k}×${n}`).join(', ')
      : 'none';

    return [
      'RECENT OUTCOMES (execution of the CURRENT plan — fold these into the refreshed strategy; double down on what worked, drop what did not):',
      `- Actions completed: ${kindLine}`,
      `- Produced: ${byRef.research} research run(s), ${byRef.post} staged post(s), ${byRef.community} community post(s), ${byRef.campaign} ad campaign shell(s)`,
      `- Ad performance: ${metricDays} metric-day(s), spend ${spend.toFixed(2)}, revenue ${revenue.toFixed(2)} (roas ${roas})`,
    ].join('\n');
  }
}
