import { NotFoundException } from '@nestjs/common';
import { InternalInsightsController } from './internal-insights.controller';

describe('InternalInsightsController', () => {
  let prisma: any;
  let ctrl: InternalInsightsController;
  const WS = { id: 'ws1', slug: 'a', productName: 'P', defaultLanguage: 'tr' };

  beforeEach(() => {
    prisma = {
      workspace: { findMany: jest.fn(), findUnique: jest.fn() },
      insightDigest: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'dg1' }),
      },
      lead: { count: jest.fn().mockResolvedValue(0) },
      review: { count: jest.fn().mockResolvedValue(0), aggregate: jest.fn().mockResolvedValue({ _avg: { rating: null } }) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
    };
    ctrl = new InternalInsightsController(prisma as any);
  });

  describe('GET jobs', () => {
    it('includes a workspace with activity and computes rounded metrics', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.lead.count.mockResolvedValueOnce(12).mockResolvedValueOnce(240); // leadsNew, leadsTotal
      prisma.review.count.mockResolvedValue(3);
      prisma.review.aggregate.mockResolvedValue({ _avg: { rating: 4.33 } });
      prisma.campaign.count.mockResolvedValue(2);

      const res = await ctrl.jobs();

      expect(res.jobs).toHaveLength(1);
      expect((res.jobs[0] as any).metrics).toEqual({
        leadsNew: 12, leadsTotal: 240, reviewsNew: 3, avgRating: 4.3, campaignsSent: 2,
      });
      expect(res.periodStart).toEqual(expect.any(String));
      expect(res.periodEnd).toEqual(expect.any(String));
    });

    it('omits a workspace with no activity (all-zero gate)', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(0);
    });

    it('omits a workspace already digested within the weekly-due window (and skips KPI work)', async () => {
      prisma.workspace.findMany.mockResolvedValue([WS]);
      prisma.insightDigest.findFirst.mockResolvedValue({ id: 'recent' });
      prisma.lead.count.mockResolvedValue(99);
      const res = await ctrl.jobs();
      expect(res.jobs).toHaveLength(0);
      expect(prisma.lead.count).not.toHaveBeenCalled();
    });
  });

  describe('POST :workspaceId/digest', () => {
    const validBody = {
      periodStart: '2026-06-07T00:00:00Z',
      periodEnd: '2026-06-14T00:00:00Z',
      metrics: { leadsNew: 5 },
      body: 'great week',
    };

    it('404s an unknown / inactive workspace', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(ctrl.submit('wsX', validBody)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates an InsightDigest scoped to the path workspace and returns its id', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ id: 'ws1', status: 'ACTIVE' });
      const res = await ctrl.submit('ws1', validBody);
      expect(res).toEqual({ id: 'dg1' });
      expect(prisma.insightDigest.create.mock.calls[0][0].data).toMatchObject({
        workspaceId: 'ws1', body: 'great week',
      });
    });
  });
});
