import { MarketingDashboardService } from './marketing-dashboard.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new MarketingDashboardService(prisma as any) };
}

/**
 * The dashboard is the first screen a user sees, so its lead totals must match
 * the lead LIST — i.e. exclude soft-deleted (deletedAt) and merged-away
 * (mergedIntoId) leads. These pin that predicate onto every lead aggregation.
 */
describe('MarketingDashboardService — active-lead scoping', () => {
  let prisma: MockPrismaClient;
  let svc: MarketingDashboardService;
  beforeEach(() => {
    ({ prisma, svc } = makeSvc());
    (prisma.lead.count as jest.Mock).mockResolvedValue(0);
    (prisma.lead.groupBy as jest.Mock).mockResolvedValue([]);
    (prisma.leadOffer.count as jest.Mock).mockResolvedValue(0);
    (prisma.marketingTask.count as jest.Mock).mockResolvedValue(0);
    (prisma.leadActivity.count as jest.Mock).mockResolvedValue(0);
  });

  it('getStats counts only active leads (every lead.count excludes deleted + merged)', async () => {
    await svc.getStats(WS, 'u1', 'MANAGER');
    const calls = (prisma.lead.count as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [arg] of calls) {
      expect(arg.where).toMatchObject({ workspaceId: WS, deletedAt: null, mergedIntoId: null });
    }
  });

  it('getLeadsByStatus groups only active leads', async () => {
    await svc.getLeadsByStatus(WS, 'u1', 'MANAGER');
    expect((prisma.lead.groupBy as jest.Mock).mock.calls[0][0].where).toMatchObject({
      workspaceId: WS,
      deletedAt: null,
      mergedIntoId: null,
    });
  });

  it('getMonthlyMetrics counts only active leads', async () => {
    await svc.getMonthlyMetrics(WS, 'u1', 'MANAGER');
    for (const [arg] of (prisma.lead.count as jest.Mock).mock.calls) {
      expect(arg.where).toMatchObject({ deletedAt: null, mergedIntoId: null });
    }
  });

  it('getTopPerformers counts only active leads (filtered relation count + groupBys)', async () => {
    (prisma.marketingUser.findMany as jest.Mock).mockResolvedValue([
      { id: 'r1', firstName: 'A', lastName: 'B', _count: { leads: 2, activities: 3 } },
    ]);
    await svc.getTopPerformers(WS);
    // the rep's lead total is a FILTERED relation count (active leads only)
    const sel = (prisma.marketingUser.findMany as jest.Mock).mock.calls[0][0].select;
    expect(sel._count.select.leads.where).toMatchObject({ deletedAt: null, mergedIntoId: null });
    // both won/open groupBys exclude deleted + merged
    for (const [arg] of (prisma.lead.groupBy as jest.Mock).mock.calls) {
      expect(arg.where).toMatchObject({ deletedAt: null, mergedIntoId: null });
    }
  });
});

// The API runs in UTC, so `new Date().setHours(0,0,0,0)` yields UTC (not the
// business's) day/month edges — mis-attributing leads/tasks/activities in the
// first offset-hours of the local day to the wrong day/month. The dashboard must
// use the WORKSPACE's configured timezone. Asserted with Asia/Tokyo (UTC+9, no
// DST) so the expectation is wrong for BOTH a UTC and a Turkey (UTC+3) runner.
describe('MarketingDashboardService — timezone-aware period boundaries', () => {
  const WS_TZ = 'ws-1';

  afterEach(() => jest.useRealTimers());

  it('getTodaySummary bounds "today" in the workspace timezone', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-01T20:00:00.000Z')); // Tokyo: Jul 2 05:00
    const { prisma, svc } = makeSvc();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ timezone: 'Asia/Tokyo' });
    (prisma.marketingTask.count as jest.Mock).mockResolvedValue(0);
    (prisma.leadActivity.count as jest.Mock).mockResolvedValue(0);

    await svc.getTodaySummary(WS_TZ, 'u1', 'MANAGER');

    expect(prisma.workspace.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: WS_TZ }, select: { timezone: true } }),
    );
    // Tokyo day Jul 2 = [2026-07-01T15:00Z, 2026-07-02T15:00Z).
    const taskCall = (prisma.marketingTask.count as jest.Mock).mock.calls[0][0];
    expect(taskCall.where.dueDate.gte.toISOString()).toBe('2026-07-01T15:00:00.000Z');
    expect(taskCall.where.dueDate.lt.toISOString()).toBe('2026-07-02T15:00:00.000Z');
  });

  it('getMonthlyMetrics bounds the month (and its label) in the workspace timezone', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-30T20:00:00.000Z')); // Tokyo: Jul 1 05:00
    const { prisma, svc } = makeSvc();
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ timezone: 'Asia/Tokyo' });
    (prisma.lead.count as jest.Mock).mockResolvedValue(0);
    (prisma.leadActivity.count as jest.Mock).mockResolvedValue(0);

    const out = await svc.getMonthlyMetrics(WS_TZ, 'u1', 'MANAGER');

    // In Tokyo it is already July; a UTC/Turkey server would still say June.
    expect(out.month).toBe('2026-07');
    const call = (prisma.lead.count as jest.Mock).mock.calls[0][0];
    expect(call.where.createdAt.gte.toISOString()).toBe('2026-06-30T15:00:00.000Z');
  });
});
