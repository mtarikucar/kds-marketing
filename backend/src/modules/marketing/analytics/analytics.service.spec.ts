import { AnalyticsService } from './analytics.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new AnalyticsService(prisma as any) };
}

describe('AnalyticsService.funnel', () => {
  it('computes totals, conversion rate, and an ordered waterfall', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.lead.groupBy as unknown as jest.Mock).mockResolvedValue([
      { status: 'NEW', _count: 5 },
      { status: 'WON', _count: 2 },
      { status: 'LOST', _count: 1 },
    ]);
    const out = await svc.funnel(WS, {});
    expect(out).toMatchObject({ total: 8, won: 2, lost: 1, open: 5, conversionRate: 25 });
    expect(out.waterfall[0]).toEqual({ status: 'NEW', count: 5 });
    expect(out.waterfall.find((w) => w.status === 'WON')).toEqual({ status: 'WON', count: 2 });
  });

  it('pins workspaceId and applies the date range', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.lead.groupBy as unknown as jest.Mock).mockResolvedValue([]);
    await svc.funnel(WS, { from: '2026-01-01', to: '2026-02-01' });
    const arg = (prisma.lead.groupBy as unknown as jest.Mock).mock.calls[0][0];
    expect(arg.where.workspaceId).toBe(WS);
    expect(arg.where.createdAt.gte).toEqual(new Date('2026-01-01'));
  });

  it('excludes soft-deleted + merged leads from every aggregation', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.lead.groupBy as unknown as jest.Mock).mockResolvedValue([]);
    (prisma.marketingUser.findMany as unknown as jest.Mock).mockResolvedValue([]);
    await svc.funnel(WS, {});
    await svc.bySource(WS, {});
    await svc.repPerformance(WS, {});
    for (const [arg] of (prisma.lead.groupBy as unknown as jest.Mock).mock.calls) {
      expect(arg.where).toMatchObject({ workspaceId: WS, mergedIntoId: null, deletedAt: null });
    }
  });
});

describe('AnalyticsService.bySource', () => {
  it('returns counts per source, sorted descending', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.lead.groupBy as unknown as jest.Mock).mockResolvedValue([
      { source: 'WEBSITE', _count: 3 },
      { source: 'INSTAGRAM', _count: 7 },
    ]);
    const out = await svc.bySource(WS, {});
    expect(out).toEqual([
      { key: 'INSTAGRAM', count: 7 },
      { key: 'WEBSITE', count: 3 },
    ]);
  });
});

describe('AnalyticsService.repPerformance', () => {
  it('rolls up totals + won per rep with a conversion rate and resolved names', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.lead.groupBy as unknown as jest.Mock).mockResolvedValue([
      { assignedToId: 'r1', status: 'NEW', _count: 2 },
      { assignedToId: 'r1', status: 'WON', _count: 2 },
      { assignedToId: null, status: 'NEW', _count: 5 },
    ]);
    (prisma.marketingUser.findMany as unknown as jest.Mock).mockResolvedValue([
      { id: 'r1', firstName: 'Alice', lastName: 'Rep' },
    ]);
    const out = await svc.repPerformance(WS, {});
    const r1 = out.find((r) => r.repId === 'r1');
    // name is resolved (not the raw UUID) so the FE renders a readable table.
    expect(r1).toMatchObject({ total: 4, won: 2, conversionRate: 50, name: 'Alice Rep' });
    expect(out.find((r) => r.repId === 'unassigned')).toMatchObject({ total: 5, won: 0, name: 'Unassigned' });
    // the name lookup is workspace-scoped to the assigned rep ids
    const arg = (prisma.marketingUser.findMany as unknown as jest.Mock).mock.calls[0][0];
    expect(arg.where).toMatchObject({ workspaceId: WS, id: { in: ['r1'] } });
  });
});
