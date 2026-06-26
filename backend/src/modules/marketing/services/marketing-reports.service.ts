import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ReportFilterDto } from '../dto/report-filter.dto';
import { rangeEndInclusive } from './report-date-range.util';

@Injectable()
export class MarketingReportsService {
  constructor(private prisma: PrismaService) {}

  async getPerformanceReport(workspaceId: string, filter: ReportFilterDto) {
    const dateFilter: any = {};
    if (filter.dateFrom) dateFilter.gte = new Date(filter.dateFrom);
    if (filter.dateTo) dateFilter.lte = rangeEndInclusive(filter.dateTo);

    const repWhere: any = {
      status: 'ACTIVE',
      ...(filter.marketingUserId ? { id: filter.marketingUserId } : {}),
    };

    const dateWhere = Object.keys(dateFilter).length ? { createdAt: dateFilter } : {};

    // Batch queries: fetch all reps + grouped counts in parallel. Every
    // query carries workspaceId inline; LeadActivity (no own column)
    // inherits scope from its parent lead.
    const [reps, leadsByRepAndStatus, activitiesByRepAndType] = await Promise.all([
      this.prisma.marketingUser.findMany({
        where: { ...repWhere, workspaceId },
        select: { id: true, firstName: true, lastName: true, role: true },
      }),
      this.prisma.lead.groupBy({
        by: ['assignedToId', 'status'],
        where: { assignedTo: { is: repWhere }, ...dateWhere, workspaceId, mergedIntoId: null, deletedAt: null },
        _count: { id: true },
      }),
      this.prisma.leadActivity.groupBy({
        by: ['createdById', 'type'],
        where: { createdBy: { is: repWhere }, ...dateWhere, lead: { workspaceId } },
        _count: { id: true },
      }),
    ]);

    // Build lookup maps
    const leadMap = new Map<string, Map<string, number>>();
    for (const row of leadsByRepAndStatus) {
      if (!row.assignedToId) continue;
      if (!leadMap.has(row.assignedToId)) leadMap.set(row.assignedToId, new Map());
      leadMap.get(row.assignedToId)!.set(row.status, row._count.id);
    }

    const activityMap = new Map<string, Map<string, number>>();
    for (const row of activitiesByRepAndType) {
      if (!activityMap.has(row.createdById)) activityMap.set(row.createdById, new Map());
      activityMap.get(row.createdById)!.set(row.type, row._count.id);
    }

    return reps.map((rep) => {
      const leads = leadMap.get(rep.id) || new Map();
      const acts = activityMap.get(rep.id) || new Map();

      const totalLeads = Array.from(leads.values()).reduce((sum, c) => sum + c, 0);
      const wonLeads = leads.get('WON') || 0;
      const lostLeads = leads.get('LOST') || 0;
      const totalActivities = Array.from(acts.values()).reduce((sum, c) => sum + c, 0);
      const demos = acts.get('DEMO') || 0;
      const meetings = acts.get('MEETING') || 0;

      const totalProcessed = wonLeads + lostLeads;
      const conversionRate = totalProcessed > 0 ? (wonLeads / totalProcessed) * 100 : 0;

      return {
        rep: { id: rep.id, name: `${rep.firstName} ${rep.lastName}`, role: rep.role },
        totalLeads,
        wonLeads,
        lostLeads,
        activities: totalActivities,
        demos,
        meetings,
        conversionRate: Math.round(conversionRate * 100) / 100,
      };
    });
  }

  async getLeadSourceReport(workspaceId: string, filter: ReportFilterDto) {
    const where: any = { mergedIntoId: null, deletedAt: null }; // exclude tombstoned (merged) + soft-deleted leads
    if (filter.dateFrom) where.createdAt = { ...where.createdAt, gte: new Date(filter.dateFrom) };
    if (filter.dateTo) where.createdAt = { ...where.createdAt, lte: rangeEndInclusive(filter.dateTo) };

    // Use groupBy instead of N separate count queries
    const [totalsBySource, statusBySource] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['source'],
        where: { ...where, workspaceId },
        _count: { id: true },
      }),
      this.prisma.lead.groupBy({
        by: ['source', 'status'],
        where: { ...where, status: { in: ['WON', 'LOST'] }, workspaceId },
        _count: { id: true },
      }),
    ]);

    const statusMap = new Map<string, { won: number; lost: number }>();
    for (const row of statusBySource) {
      if (!statusMap.has(row.source)) statusMap.set(row.source, { won: 0, lost: 0 });
      const entry = statusMap.get(row.source)!;
      if (row.status === 'WON') entry.won = row._count.id;
      if (row.status === 'LOST') entry.lost = row._count.id;
    }

    return totalsBySource
      .map((group) => {
        const { won, lost } = statusMap.get(group.source) || { won: 0, lost: 0 };
        const processed = won + lost;
        const conversionRate = processed > 0 ? (won / processed) * 100 : 0;
        return {
          source: group.source,
          total: group._count.id,
          won,
          lost,
          conversionRate: Math.round(conversionRate * 100) / 100,
        };
      })
      .filter((d) => d.total > 0);
  }

  async getRegionalReport(workspaceId: string, filter: ReportFilterDto) {
    const where: any = { mergedIntoId: null, deletedAt: null }; // exclude tombstoned (merged) + soft-deleted leads
    if (filter.dateFrom) where.createdAt = { ...where.createdAt, gte: new Date(filter.dateFrom) };
    if (filter.dateTo) where.createdAt = { ...where.createdAt, lte: rangeEndInclusive(filter.dateTo) };

    // Batch: total by city
    const totals = await this.prisma.lead.groupBy({
      by: ['city'],
      where: { ...where, city: { not: null }, workspaceId },
      _count: { id: true },
    });

    // Batch: won by city (single query instead of N+1)
    const wonTotals = await this.prisma.lead.groupBy({
      by: ['city'],
      where: { ...where, city: { not: null }, status: 'WON', workspaceId },
      _count: { id: true },
    });

    const wonMap = new Map(wonTotals.map((w) => [w.city, w._count.id]));

    const data = totals.map((group) => ({
      city: group.city,
      total: group._count.id,
      won: wonMap.get(group.city) || 0,
    }));

    return data.sort((a, b) => b.total - a.total);
  }

  async getConversionFunnel(workspaceId: string, filter: ReportFilterDto) {
    const where: any = { mergedIntoId: null, deletedAt: null }; // exclude tombstoned (merged) + soft-deleted leads
    if (filter.dateFrom) where.createdAt = { ...where.createdAt, gte: new Date(filter.dateFrom) };
    if (filter.dateTo) where.createdAt = { ...where.createdAt, lte: rangeEndInclusive(filter.dateTo) };

    const statuses = [
      'NEW', 'CONTACTED', 'NOT_REACHABLE', 'MEETING_DONE', 'DEMO_SCHEDULED',
      'OFFER_SENT', 'WAITING', 'WON', 'LOST',
    ];

    // Use groupBy instead of N separate count queries
    const groups = await this.prisma.lead.groupBy({
      by: ['status'],
      where: { ...where, workspaceId },
      _count: { id: true },
    });

    const countMap = new Map(groups.map((g) => [g.status, g._count.id]));

    return statuses.map((status) => ({
      status,
      count: countMap.get(status) || 0,
    }));
  }
}
