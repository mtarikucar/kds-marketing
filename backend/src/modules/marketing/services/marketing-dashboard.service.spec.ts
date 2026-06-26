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
});
