import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

interface DateRange {
  from?: string;
  to?: string;
}

// Pipeline order for the funnel waterfall.
const FUNNEL_ORDER = [
  'NEW',
  'CONTACTED',
  'MEETING_DONE',
  'DEMO_SCHEDULED',
  'OFFER_SENT',
  'WAITING',
  'WON',
];

/**
 * Epic G — read-only lead analytics (funnel, source/business-type breakdown,
 * rep performance). Pure aggregation over the leads table; every query pins
 * workspaceId. No writes, no schema — safe to add to a live system.
 */
@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  private range(r: DateRange): Prisma.LeadWhereInput {
    if (!r.from && !r.to) return {};
    const createdAt: Prisma.DateTimeFilter = {};
    if (r.from) createdAt.gte = new Date(r.from);
    if (r.to) createdAt.lte = new Date(r.to);
    return { createdAt };
  }

  async funnel(workspaceId: string, r: DateRange) {
    const grouped = await this.prisma.lead.groupBy({
      by: ['status'],
      where: { workspaceId, ...this.range(r) },
      _count: true,
    });
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const g of grouped) {
      byStatus[g.status] = g._count;
      total += g._count;
    }
    const won = byStatus['WON'] ?? 0;
    const lost = byStatus['LOST'] ?? 0;
    const waterfall = FUNNEL_ORDER.map((status) => ({ status, count: byStatus[status] ?? 0 }));
    return {
      total,
      won,
      lost,
      open: total - won - lost,
      conversionRate: total ? Math.round((won / total) * 1000) / 10 : 0,
      waterfall,
      byStatus,
    };
  }

  private async breakdown(workspaceId: string, field: 'source' | 'businessType', r: DateRange) {
    const grouped = await this.prisma.lead.groupBy({
      by: [field],
      where: { workspaceId, ...this.range(r) },
      _count: true,
    });
    return grouped
      .map((g) => ({ key: (g as Record<string, unknown>)[field] as string, count: g._count }))
      .sort((a, b) => b.count - a.count);
  }

  bySource(workspaceId: string, r: DateRange) {
    return this.breakdown(workspaceId, 'source', r);
  }

  byBusinessType(workspaceId: string, r: DateRange) {
    return this.breakdown(workspaceId, 'businessType', r);
  }

  async repPerformance(workspaceId: string, r: DateRange) {
    const grouped = await this.prisma.lead.groupBy({
      by: ['assignedToId', 'status'],
      where: { workspaceId, ...this.range(r) },
      _count: true,
    });
    const reps: Record<string, { repId: string; total: number; won: number; lost: number }> = {};
    for (const g of grouped) {
      const id = g.assignedToId ?? 'unassigned';
      reps[id] ??= { repId: id, total: 0, won: 0, lost: 0 };
      reps[id].total += g._count;
      if (g.status === 'WON') reps[id].won += g._count;
      if (g.status === 'LOST') reps[id].lost += g._count;
    }
    return Object.values(reps)
      .map((rep) => ({
        ...rep,
        conversionRate: rep.total ? Math.round((rep.won / rep.total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.won - a.won);
  }
}
