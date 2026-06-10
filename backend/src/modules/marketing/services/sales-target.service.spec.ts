import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SalesTargetService } from './sales-target.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('SalesTargetService', () => {
  let prisma: MockPrismaClient;
  let svc: SalesTargetService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new SalesTargetService(prisma as any);
  });

  describe('setTarget', () => {
    it('upserts a target keyed on (rep, period, metric)', async () => {
      prisma.salesTarget.upsert.mockResolvedValue({ id: 't-1' } as any);
      await svc.setTarget(
        { marketingUserId: 'rep-1', period: '2026-06', metric: 'WON_LEADS', targetValue: 10 } as any,
        'mgr-1',
      );
      expect(prisma.salesTarget.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            marketingUserId_period_metric: {
              marketingUserId: 'rep-1',
              period: '2026-06',
              metric: 'WON_LEADS',
            },
          },
          create: expect.objectContaining({ targetValue: 10, setById: 'mgr-1' }),
          update: expect.objectContaining({ targetValue: 10, setById: 'mgr-1' }),
        }),
      );
    });
  });

  describe('performanceFor', () => {
    it('computes attainment per metric against the rep actuals', async () => {
      prisma.salesTarget.findMany.mockResolvedValue([
        { metric: 'WON_LEADS', targetValue: new Prisma.Decimal(10) },
        { metric: 'COMMISSION_AMOUNT', targetValue: new Prisma.Decimal(1000) },
      ] as any);
      prisma.lead.count.mockResolvedValue(7);
      (prisma.commission.aggregate as any).mockResolvedValue({
        _sum: { amount: new Prisma.Decimal(750) },
      });
      prisma.salesCall.count.mockResolvedValue(5);

      const perf = await svc.performanceFor('rep-1', '2026-06');

      expect(perf).toEqual([
        { metric: 'WON_LEADS', target: 10, actual: 7, attainmentPct: 70 },
        { metric: 'COMMISSION_AMOUNT', target: 1000, actual: 750, attainmentPct: 75 },
        { metric: 'CONNECTED_CALLS', target: null, actual: 5, attainmentPct: null },
      ]);
      // WON_LEADS actual is scoped to the rep + WON + the period window.
      expect(prisma.lead.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ assignedToId: 'rep-1', status: 'WON' }),
        }),
      );
      // COMMISSION_AMOUNT uses the commission.period string directly.
      expect(prisma.commission.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { marketingUserId: 'rep-1', period: '2026-06' } }),
      );
    });
  });

  describe('list', () => {
    it('scopes a SALES_REP to their own targets', async () => {
      prisma.salesTarget.findMany.mockResolvedValue([]);
      await svc.list({}, { id: 'rep-1', role: 'SALES_REP' } as any);
      expect(prisma.salesTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { marketingUserId: 'rep-1' } }),
      );
    });

    it('lets a manager filter by rep + period', async () => {
      prisma.salesTarget.findMany.mockResolvedValue([]);
      await svc.list(
        { marketingUserId: 'rep-9', period: '2026-06' },
        { id: 'mgr-1', role: 'SALES_MANAGER' } as any,
      );
      expect(prisma.salesTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { marketingUserId: 'rep-9', period: '2026-06' } }),
      );
    });
  });

  describe('remove', () => {
    it('throws when the target is missing', async () => {
      prisma.salesTarget.findUnique.mockResolvedValue(null);
      await expect(svc.remove('x')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('teamPerformance', () => {
    // v3.0.1 round-4 — switched to batched groupBy queries instead of per-rep
    // findMany + aggregate + count, so the mocks return the pivoted shape.
    it('returns per-metric attainment for every active rep', async () => {
      prisma.marketingUser.findMany.mockResolvedValue([
        { id: 'rep-1', firstName: 'Ada', lastName: 'Lovelace', role: 'SALES_REP' },
      ] as any);
      prisma.salesTarget.findMany.mockResolvedValue([
        { marketingUserId: 'rep-1', metric: 'WON_LEADS', targetValue: new Prisma.Decimal(5) },
      ] as any);
      (prisma.lead.groupBy as any).mockResolvedValue([
        { assignedToId: 'rep-1', _count: { _all: 4 } },
      ]);
      (prisma.commission.groupBy as any).mockResolvedValue([]);
      (prisma.salesCall.groupBy as any).mockResolvedValue([]);

      const team = await svc.teamPerformance('2026-06');

      expect(team).toHaveLength(1);
      expect(team[0].marketingUser.id).toBe('rep-1');
      expect(team[0].metrics).toHaveLength(3);
      expect(team[0].metrics.find((m) => m.metric === 'WON_LEADS')).toEqual({
        metric: 'WON_LEADS',
        target: 5,
        actual: 4,
        attainmentPct: 80,
      });
      // active filter is applied
      expect(prisma.marketingUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'ACTIVE' } }),
      );
    });

    it('returns empty when no active reps (skip downstream queries)', async () => {
      prisma.marketingUser.findMany.mockResolvedValue([] as any);
      const team = await svc.teamPerformance('2026-06');
      expect(team).toEqual([]);
      // No fan-out fired.
      expect(prisma.lead.groupBy).not.toHaveBeenCalled();
      expect(prisma.commission.groupBy).not.toHaveBeenCalled();
      expect(prisma.salesCall.groupBy).not.toHaveBeenCalled();
    });
  });
});
