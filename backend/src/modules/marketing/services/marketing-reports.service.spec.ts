import { MarketingReportsService } from './marketing-reports.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new MarketingReportsService(prisma as any) };
}

/**
 * Reports feed the analytics dashboards, so every lead aggregation must exclude
 * soft-deleted (deletedAt) and merged-away (mergedIntoId) leads — matching the
 * lead list. These pin that predicate across all four report queries.
 */
describe('MarketingReportsService — active-lead scoping', () => {
  let prisma: MockPrismaClient;
  let svc: MarketingReportsService;
  beforeEach(() => {
    ({ prisma, svc } = makeSvc());
    (prisma.lead.groupBy as jest.Mock).mockResolvedValue([]);
    (prisma.marketingUser.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.leadActivity.groupBy as jest.Mock).mockResolvedValue([]);
  });

  const assertAllLeadGroupBysActive = () => {
    const calls = (prisma.lead.groupBy as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [arg] of calls) {
      expect(arg.where).toMatchObject({ workspaceId: WS, mergedIntoId: null, deletedAt: null });
    }
  };

  it('getPerformanceReport scopes lead groupBy to active leads', async () => {
    await svc.getPerformanceReport(WS, {} as any);
    assertAllLeadGroupBysActive();
  });

  it('getLeadSourceReport scopes lead groupBy to active leads', async () => {
    await svc.getLeadSourceReport(WS, {} as any);
    assertAllLeadGroupBysActive();
  });

  it('getRegionalReport scopes lead groupBy to active leads', async () => {
    await svc.getRegionalReport(WS, {} as any);
    assertAllLeadGroupBysActive();
  });

  it('getConversionFunnel scopes lead groupBy to active leads', async () => {
    await svc.getConversionFunnel(WS, {} as any);
    assertAllLeadGroupBysActive();
  });
});
