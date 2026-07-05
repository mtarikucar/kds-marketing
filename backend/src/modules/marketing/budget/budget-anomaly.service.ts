import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { growthAutopilotAutonomyEnabled } from './growth-autonomy.flag';

export interface AnomalyResult {
  tripped: boolean;
  reason?: string;
}

interface BudgetShape {
  id: string;
  workspaceId: string;
  autonomyLevel?: string | null;
}

const VELOCITY_MULTIPLIER = 3; // 24h spend > 3× daily cap
const ROAS_COLLAPSE_RATIO = 0.3; // today < 30% of 7d baseline
const ROAS_MIN_SPEND_OF_CAP = 0.2; // …while spending > 20% of the cap
const MAX_FAILED_AUTO_RUNS_24H = 5;

/**
 * Anomaly auto-stop (Growth Autopilot spec D11). In the AUTONOMOUS lane the
 * machine guardrails replace the human gate, so the machine must also be able
 * to STOP ITSELF: abnormal spend velocity, a collapsing ROAS, or repeated
 * failed autonomous writes pause the budget instantly and record a
 * plain-language ANOMALY_STOP run — the user is informed after the fact,
 * never asked. Only armed AUTONOMOUS budgets are evaluated (pausing a
 * SHADOW/ASSISTED budget would change today's behavior for no protection —
 * those lanes never auto-spend).
 */
@Injectable()
export class BudgetAnomalyService {
  private readonly logger = new Logger(BudgetAnomalyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async evaluate(workspaceId: string, budget: BudgetShape, now: Date = new Date()): Promise<AnomalyResult> {
    if (budget.autonomyLevel !== 'AUTONOMOUS' || !growthAutopilotAutonomyEnabled()) {
      return { tripped: false };
    }

    const dayAgo = new Date(now.getTime() - 86_400_000);

    // (a) Spend velocity vs the pacer's recommended daily cap.
    const [spent, pacing] = await Promise.all([
      this.prisma.spendLedger.aggregate({
        where: { workspaceId, budgetId: budget.id, createdAt: { gte: dayAgo }, delta: { lt: 0 } },
        _sum: { delta: true },
      }),
      this.prisma.pacingState.findUnique({
        where: { budgetId_channel: { budgetId: budget.id, channel: '' } },
        select: { recommendedDailyCap: true },
      }),
    ]);
    const spent24h = toNum(spent._sum.delta) * -1;
    const cap = toNum(pacing?.recommendedDailyCap);
    if (cap > 0 && spent24h > VELOCITY_MULTIPLIER * cap) {
      return this.trip(workspaceId, budget.id, `spend velocity: ${spent24h.toFixed(2)} in 24h exceeds ${VELOCITY_MULTIPLIER}× the ${cap.toFixed(2)} daily cap`);
    }

    // (b) ROAS collapse vs the trailing-7d baseline (needs real baseline revenue).
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const [baseline, current] = await Promise.all([
      this.prisma.adMetric.aggregate({
        where: { workspaceId, date: { gte: weekAgo, lt: today } },
        _sum: { spend: true, revenue: true },
      }),
      this.prisma.adMetric.aggregate({
        where: { workspaceId, date: { gte: today } },
        _sum: { spend: true, revenue: true },
      }),
    ]);
    const baseSpend = toNum(baseline._sum.spend);
    const baseRevenue = toNum(baseline._sum.revenue);
    const todaySpend = toNum(current._sum.spend);
    const todayRevenue = toNum(current._sum.revenue);
    if (baseSpend > 0 && baseRevenue > 0 && cap > 0 && todaySpend > ROAS_MIN_SPEND_OF_CAP * cap) {
      const baselineRoas = baseRevenue / baseSpend;
      const todayRoas = todaySpend > 0 ? todayRevenue / todaySpend : 0;
      if (todayRoas < ROAS_COLLAPSE_RATIO * baselineRoas) {
        return this.trip(workspaceId, budget.id, `roas collapse: today ${todayRoas.toFixed(2)} vs 7d baseline ${baselineRoas.toFixed(2)}`);
      }
    }

    // (c) Repeated failed autonomous writes.
    const failed = await this.prisma.autopilotRun.count({
      where: { workspaceId, budgetId: budget.id, autonomy: 'AUTO', ok: false, createdAt: { gte: dayAgo } },
    });
    if (failed >= MAX_FAILED_AUTO_RUNS_24H) {
      return this.trip(workspaceId, budget.id, `error spike: ${failed} failed autonomous runs in 24h`);
    }

    return { tripped: false };
  }

  /** Pause + audit — the machine stops itself without asking. */
  private async trip(workspaceId: string, budgetId: string, reason: string): Promise<AnomalyResult> {
    await this.prisma.growthBudget.updateMany({
      where: { id: budgetId, workspaceId },
      data: { status: 'PAUSED' },
    });
    await this.prisma.autopilotRun.create({
      data: {
        workspaceId,
        budgetId,
        kind: 'ANOMALY_STOP',
        autonomy: 'AUTO',
        objective: Prisma.JsonNull,
        before: Prisma.JsonNull,
        after: { reason } as Prisma.InputJsonValue,
        ok: false,
      },
      select: { id: true },
    });
    this.logger.warn(`anomaly auto-stop paused budget ${budgetId}: ${reason}`);
    return { tripped: true, reason };
  }
}

function toNum(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : typeof v === 'number' ? v : v.toNumber();
}
