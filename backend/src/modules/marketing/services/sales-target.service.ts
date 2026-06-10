import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SetTargetDto,
  TargetFilterDto,
  TargetMetric,
  TARGET_METRICS,
} from '../dto/sales-target.dto';
import { MarketingUserPayload } from '../types';

export interface MetricPerformance {
  metric: TargetMetric;
  target: number | null;
  actual: number;
  attainmentPct: number | null;
}

/**
 * Phase 4 sales targets/quotas + performance-vs-target. A manager sets a
 * per-rep, per-period (YYYY-MM) target; performance is computed from
 * marketing-owned data only (won leads, commission amounts, connected calls) —
 * no core access.
 */
@Injectable()
export class SalesTargetService {
  constructor(private readonly prisma: PrismaService) {}

  /** Manager sets (or updates) a rep's target for a period+metric. */
  setTarget(dto: SetTargetDto, setById: string) {
    return this.prisma.salesTarget.upsert({
      where: {
        marketingUserId_period_metric: {
          marketingUserId: dto.marketingUserId,
          period: dto.period,
          metric: dto.metric,
        },
      },
      create: {
        marketingUserId: dto.marketingUserId,
        period: dto.period,
        metric: dto.metric,
        targetValue: dto.targetValue,
        notes: dto.notes ?? null,
        setById,
      },
      update: {
        targetValue: dto.targetValue,
        notes: dto.notes ?? null,
        setById,
      },
    });
  }

  list(filter: TargetFilterDto, user: MarketingUserPayload) {
    const where: Prisma.SalesTargetWhereInput = {};
    if (user.role === 'SALES_REP') {
      where.marketingUserId = user.id; // reps see only their own targets
    } else if (filter.marketingUserId) {
      where.marketingUserId = filter.marketingUserId;
    }
    if (filter.period) where.period = filter.period;
    return this.prisma.salesTarget.findMany({
      where,
      orderBy: [{ period: 'desc' }, { metric: 'asc' }],
    });
  }

  async remove(id: string) {
    const target = await this.prisma.salesTarget.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Target not found');
    await this.prisma.salesTarget.delete({ where: { id } });
    return { deleted: true };
  }

  /** Performance vs target for a rep + period across every metric. */
  async performanceFor(marketingUserId: string, period: string): Promise<MetricPerformance[]> {
    const targets = await this.prisma.salesTarget.findMany({
      where: { marketingUserId, period },
    });
    const targetByMetric = new Map(targets.map((t) => [t.metric, t]));
    const actuals = await this.actualsFor(marketingUserId, period);

    return TARGET_METRICS.map((metric) => {
      const target = targetByMetric.get(metric);
      const targetValue = target ? Number(target.targetValue) : null;
      const actual = actuals[metric];
      const attainmentPct =
        targetValue && targetValue > 0
          ? Math.round((actual / targetValue) * 10000) / 100
          : null;
      return { metric, target: targetValue, actual, attainmentPct };
    });
  }

  /**
   * Whole-team attainment for a period (managers).
   *
   * v3.0.1 round-4 audit fix — pre-fix this fanned out into one
   * `salesTarget.findMany` + three `actualsFor` queries per rep. 50
   * reps × 4 queries = 200 round trips. Now: one batched targets
   * lookup + three batched aggregates over the whole rep set, pivoted
   * in memory. 4 queries total regardless of headcount.
   */
  async teamPerformance(period: string) {
    const reps = await this.prisma.marketingUser.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, firstName: true, lastName: true, role: true },
      orderBy: { firstName: 'asc' },
    });
    if (reps.length === 0) return [];
    const repIds = reps.map((r) => r.id);
    const { start, end } = this.periodRange(period);

    // Batch the four "actuals + target" reads across every rep at once.
    // Each call returns rows keyed by marketingUserId so we can pivot
    // back into the per-rep MetricPerformance arrays cheaply.
    const [targets, wonLeads, commissions, connectedCalls] = await Promise.all([
      this.prisma.salesTarget.findMany({
        where: { marketingUserId: { in: repIds }, period },
      }),
      this.prisma.lead.groupBy({
        by: ['assignedToId'],
        where: {
          assignedToId: { in: repIds },
          status: 'WON',
          convertedAt: { gte: start, lt: end },
        },
        _count: { _all: true },
      }),
      this.prisma.commission.groupBy({
        by: ['marketingUserId'],
        where: { marketingUserId: { in: repIds }, period },
        _sum: { amount: true },
      }),
      this.prisma.salesCall.groupBy({
        by: ['marketingUserId'],
        where: {
          marketingUserId: { in: repIds },
          status: 'CONNECTED',
          startedAt: { gte: start, lt: end },
        },
        _count: { _all: true },
      }),
    ]);

    // Pivot index helpers.
    const targetsByRepMetric = new Map<string, Map<TargetMetric, number>>();
    for (const t of targets) {
      let inner = targetsByRepMetric.get(t.marketingUserId);
      if (!inner) {
        inner = new Map();
        targetsByRepMetric.set(t.marketingUserId, inner);
      }
      inner.set(t.metric as TargetMetric, Number(t.targetValue));
    }
    const wonByRep = new Map(
      wonLeads
        .filter((w) => w.assignedToId != null)
        .map((w) => [w.assignedToId as string, w._count._all]),
    );
    const commByRep = new Map(
      commissions.map((c) => [c.marketingUserId, Number(c._sum.amount ?? 0)]),
    );
    const callsByRep = new Map(
      connectedCalls.map((c) => [c.marketingUserId, c._count._all]),
    );

    return reps.map((rep) => {
      const targets = targetsByRepMetric.get(rep.id) ?? new Map();
      const actuals: Record<TargetMetric, number> = {
        WON_LEADS: wonByRep.get(rep.id) ?? 0,
        COMMISSION_AMOUNT: commByRep.get(rep.id) ?? 0,
        CONNECTED_CALLS: callsByRep.get(rep.id) ?? 0,
      };
      const metrics: MetricPerformance[] = TARGET_METRICS.map((metric) => {
        const targetValue = targets.get(metric) ?? null;
        const actual = actuals[metric];
        const attainmentPct =
          targetValue && targetValue > 0
            ? Math.round((actual / targetValue) * 10000) / 100
            : null;
        return { metric, target: targetValue, actual, attainmentPct };
      });
      return { marketingUser: rep, metrics };
    });
  }

  private async actualsFor(
    marketingUserId: string,
    period: string,
  ): Promise<Record<TargetMetric, number>> {
    const { start, end } = this.periodRange(period);
    const [wonLeads, commissionAgg, connectedCalls] = await Promise.all([
      this.prisma.lead.count({
        where: {
          assignedToId: marketingUserId,
          status: 'WON',
          convertedAt: { gte: start, lt: end },
        },
      }),
      this.prisma.commission.aggregate({
        where: { marketingUserId, period },
        _sum: { amount: true },
      }),
      this.prisma.salesCall.count({
        where: {
          marketingUserId,
          status: 'CONNECTED',
          startedAt: { gte: start, lt: end },
        },
      }),
    ]);
    return {
      WON_LEADS: wonLeads,
      COMMISSION_AMOUNT: Number(commissionAgg._sum.amount ?? 0),
      CONNECTED_CALLS: connectedCalls,
    };
  }

  /** [start, end) UTC bounds for a YYYY-MM period. */
  private periodRange(period: string): { start: Date; end: Date } {
    const [y, m] = period.split('-').map(Number);
    return {
      start: new Date(Date.UTC(y, m - 1, 1)),
      end: new Date(Date.UTC(y, m, 1)),
    };
  }
}
