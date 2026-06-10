import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class MarketingDashboardService {
  constructor(private prisma: PrismaService) {}

  async getStats(workspaceId: string, userId: string, userRole: string) {
    const where = userRole === 'REP' ? { assignedToId: userId } : {};
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
            where: { workspaceId, assignedToId: null, status: { notIn: ['WON', 'LOST'] } },
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
    const where = userRole === 'REP' ? { assignedToId: userId } : {};

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

  async getTodaySummary(workspaceId: string, userId: string, userRole: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const taskWhere: any = {
      dueDate: { gte: today, lt: tomorrow },
      status: { not: 'CANCELLED' },
    };

    const activityWhere: any = {
      createdAt: { gte: today, lt: tomorrow },
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
          dueDate: { lt: today },
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
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const where = userRole === 'REP' ? { assignedToId: userId } : {};

    const [newLeads, wonLeads, activitiesCount] = await Promise.all([
      this.prisma.lead.count({
        where: { ...where, createdAt: { gte: firstDay, lte: lastDay }, workspaceId },
      }),
      this.prisma.lead.count({
        where: { ...where, status: 'WON', convertedAt: { gte: firstDay, lte: lastDay }, workspaceId },
      }),
      this.prisma.leadActivity.count({
        where: {
          // Activity scope is inherited from the parent lead's workspace.
          lead: { workspaceId },
          createdAt: { gte: firstDay, lte: lastDay },
          ...(userRole === 'REP' ? { createdById: userId } : {}),
        },
      }),
    ]);

    return {
      month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      newLeads,
      wonLeads,
      activitiesCount,
    };
  }

  async getTopPerformers(workspaceId: string, limit = 10) {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);

    // Single query: get reps with counts
    const reps = await this.prisma.marketingUser.findMany({
      where: { workspaceId, role: 'REP', status: 'ACTIVE' },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        _count: {
          select: { leads: true, activities: true },
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
