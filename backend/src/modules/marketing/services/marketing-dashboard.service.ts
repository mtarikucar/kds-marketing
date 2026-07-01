import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { zonedParts, zonedWallTimeToUtcMs } from '../sites/timezone-slots';

/**
 * Active leads only — exclude soft-deleted (deletedAt) and merged-away
 * (mergedIntoId) rows, exactly as the lead list does, so the dashboard's
 * totals/funnel match what the user can actually see (a deleted or merged
 * lead must not inflate "total leads", WON/LOST, or the status breakdown).
 */
const ACTIVE_LEAD = { deletedAt: null, mergedIntoId: null } as const;

@Injectable()
export class MarketingDashboardService {
  constructor(private prisma: PrismaService) {}

  async getStats(workspaceId: string, userId: string, userRole: string) {
    const where = userRole === 'REP' ? { ...ACTIVE_LEAD, assignedToId: userId } : { ...ACTIVE_LEAD };
    // Manager-wide widgets (e.g. the unassigned-leads dispatch queue) are for
    // everyone ABOVE rep — OWNER included, not an equality on MANAGER.
    const isManager = userRole !== 'REP';

    // workspaceId is spread inline at every call site (not folded into the
    // shared filter object) so each query is visibly workspace-scoped.
    const [
      totalLeads,
      newLeads,
      wonLeads,
      lostLeads,
      activeOffers,
      pendingTasks,
      unassignedLeads,
    ] = await Promise.all([
      this.prisma.lead.count({ where: { ...where, workspaceId } }),
      this.prisma.lead.count({ where: { ...where, status: 'NEW', workspaceId } }),
      this.prisma.lead.count({ where: { ...where, status: 'WON', workspaceId } }),
      this.prisma.lead.count({ where: { ...where, status: 'LOST', workspaceId } }),
      this.prisma.leadOffer.count({
        where: {
          workspaceId,
          status: { in: ['DRAFT', 'SENT'] },
          ...(userRole === 'REP' ? { createdById: userId } : {}),
        },
      }),
      this.prisma.marketingTask.count({
        where: {
          workspaceId,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
          ...(userRole === 'REP' ? { assignedToId: userId } : {}),
        },
      }),
      // Managers see how much of the pipeline is waiting on dispatch;
      // for a rep this is always 0 (their own bucket is all assigned).
      isManager
        ? this.prisma.lead.count({
            where: { workspaceId, assignedToId: null, status: { notIn: ['WON', 'LOST'] }, ...ACTIVE_LEAD },
          })
        : Promise.resolve(0),
    ]);

    const totalProcessed = wonLeads + lostLeads;
    const conversionRate = totalProcessed > 0 ? (wonLeads / totalProcessed) * 100 : 0;

    return {
      totalLeads,
      newLeads,
      wonLeads,
      lostLeads,
      activeOffers,
      pendingTasks,
      // Manager-only metric; UI hides the card when role !== manager,
      // but expose the field unconditionally so a rep client doesn't
      // crash on a missing key.
      unassignedLeads,
      conversionRate: Math.round(conversionRate * 100) / 100,
    };
  }

  async getLeadsByStatus(workspaceId: string, userId: string, userRole: string) {
    const where = userRole === 'REP' ? { ...ACTIVE_LEAD, assignedToId: userId } : { ...ACTIVE_LEAD };

    // Use groupBy instead of N separate count queries
    const grouped = await this.prisma.lead.groupBy({
      by: ['status'],
      where: { ...where, workspaceId },
      _count: { id: true },
    });

    const allStatuses = [
      'NEW', 'CONTACTED', 'NOT_REACHABLE', 'MEETING_DONE',
      'DEMO_SCHEDULED', 'OFFER_SENT', 'WAITING', 'WON', 'LOST',
    ];

    const countMap = new Map(grouped.map((g) => [g.status, g._count.id]));

    return allStatuses.map((status) => ({
      status,
      count: countMap.get(status) || 0,
    }));
  }

  /**
   * Day / month boundaries in the WORKSPACE's configured timezone, as UTC Dates
   * for Prisma. The API runs in UTC, so `new Date().setHours(0,0,0,0)` produced
   * UTC — not the business's — day/month edges, mis-attributing every lead/task/
   * activity in the first offset-hours of the local day to the wrong day/month
   * (a Turkey UTC+3 workspace lost its 00:00–03:00 to "yesterday"). Booking already
   * interprets wall-clock in the workspace tz; the dashboard now matches. DST-safe
   * via Intl; day/month overflow (d+1, mo+1) normalizes through Date.UTC.
   */
  private async periodBounds(workspaceId: string) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { timezone: true },
    });
    const tz = ws?.timezone || 'UTC';
    const { y, mo, d } = zonedParts(Date.now(), tz);
    return {
      tz,
      todayStart: new Date(zonedWallTimeToUtcMs(y, mo, d, 0, 0, tz)),
      tomorrowStart: new Date(zonedWallTimeToUtcMs(y, mo, d + 1, 0, 0, tz)),
      monthStart: new Date(zonedWallTimeToUtcMs(y, mo, 1, 0, 0, tz)),
      nextMonthStart: new Date(zonedWallTimeToUtcMs(y, mo + 1, 1, 0, 0, tz)),
      monthLabel: `${y}-${String(mo).padStart(2, '0')}`,
    };
  }

  async getTodaySummary(workspaceId: string, userId: string, userRole: string) {
    const { todayStart, tomorrowStart } = await this.periodBounds(workspaceId);

    const taskWhere: any = {
      dueDate: { gte: todayStart, lt: tomorrowStart },
      status: { not: 'CANCELLED' },
    };

    const activityWhere: any = {
      createdAt: { gte: todayStart, lt: tomorrowStart },
    };

    if (userRole === 'REP') {
      taskWhere.assignedToId = userId;
      activityWhere.createdById = userId;
    }

    const [todayTasks, completedTasks, todayActivities, overdueTasks] = await Promise.all([
      this.prisma.marketingTask.count({ where: { ...taskWhere, workspaceId } }),
      this.prisma.marketingTask.count({
        where: { ...taskWhere, status: 'COMPLETED', workspaceId },
      }),
      // LeadActivity has no workspaceId column — it inherits scope from
      // its parent lead.
      this.prisma.leadActivity.count({
        where: { ...activityWhere, lead: { workspaceId } },
      }),
      this.prisma.marketingTask.count({
        where: {
          workspaceId,
          dueDate: { lt: todayStart },
          status: { in: ['PENDING', 'IN_PROGRESS'] },
          ...(userRole === 'REP' ? { assignedToId: userId } : {}),
        },
      }),
    ]);

    return {
      todayTasks,
      completedTasks,
      todayActivities,
      overdueTasks,
    };
  }

  async getMonthlyMetrics(workspaceId: string, userId: string, userRole: string) {
    const { monthStart, nextMonthStart, monthLabel } = await this.periodBounds(workspaceId);
    const range = { gte: monthStart, lt: nextMonthStart };

    const where = userRole === 'REP' ? { ...ACTIVE_LEAD, assignedToId: userId } : { ...ACTIVE_LEAD };

    const [newLeads, wonLeads, activitiesCount] = await Promise.all([
      this.prisma.lead.count({
        where: { ...where, createdAt: range, workspaceId },
      }),
      this.prisma.lead.count({
        where: { ...where, status: 'WON', convertedAt: range, workspaceId },
      }),
      this.prisma.leadActivity.count({
        where: {
          // Activity scope is inherited from the parent lead's workspace.
          lead: { workspaceId },
          createdAt: range,
          ...(userRole === 'REP' ? { createdById: userId } : {}),
        },
      }),
    ]);

    return {
      month: monthLabel,
      newLeads,
      wonLeads,
      activitiesCount,
    };
  }

  async getTopPerformers(workspaceId: string, limit = 10) {
    const { monthStart: firstDay } = await this.periodBounds(workspaceId);

    // Single query: get reps with counts
    const reps = await this.prisma.marketingUser.findMany({
      where: { workspaceId, role: 'REP', status: 'ACTIVE' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        _count: {
          // Count only ACTIVE leads toward the rep's total (a soft-deleted /
          // merged lead is hidden from the list, so it must not pad the widget).
          select: { leads: { where: { ...ACTIVE_LEAD } }, activities: true },
        },
      },
    });

    if (reps.length === 0) return [];

    // Batch query for won leads this month instead of N+1
    const [wonCounts, openCounts] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['assignedToId'],
        where: {
          workspaceId,
          assignedToId: { in: reps.map((r) => r.id) },
          status: 'WON',
          convertedAt: { gte: firstDay },
          ...ACTIVE_LEAD,
        },
        _count: { id: true },
      }),
      // Open = non-terminal — answers "who is currently buried under
      // work?" so the manager can decide where to (or not to) dispatch.
      this.prisma.lead.groupBy({
        by: ['assignedToId'],
        where: {
          workspaceId,
          assignedToId: { in: reps.map((r) => r.id) },
          status: { notIn: ['WON', 'LOST'] },
          ...ACTIVE_LEAD,
        },
        _count: { id: true },
      }),
    ]);

    const wonMap = new Map(
      wonCounts.map((w) => [w.assignedToId, w._count.id]),
    );
    const openMap = new Map(
      openCounts.map((o) => [o.assignedToId, o._count.id]),
    );

    return reps
      .map((rep) => ({
        id: rep.id,
        name: `${rep.firstName} ${rep.lastName}`,
        totalLeads: rep._count.leads,
        totalActivities: rep._count.activities,
        wonThisMonth: wonMap.get(rep.id) || 0,
        openLeads: openMap.get(rep.id) || 0,
      }))
      .sort((a, b) => b.wonThisMonth - a.wonThisMonth)
      .slice(0, limit);
  }
}
