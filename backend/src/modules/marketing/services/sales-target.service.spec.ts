import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SalesTargetService } from './sales-target.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

describe('SalesTargetService', () => {
  let prisma: MockPrismaClient;
  let svc: SalesTargetService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new SalesTargetService(prisma as any);
    // Target users resolve in-workspace by default; per-test overrides below.
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'rep-1' } as any);
  });

  describe('setTarget', () => {
    it('upserts a target keyed on (rep, period, metric) with the workspace on the create side', async () => {
      prisma.salesTarget.upsert.mockResolvedValue({ id: 't-1' } as any);
      await svc.setTarget(
        WS,
        { marketingUserId: 'rep-1', period: '2026-06', metric: 'WON_LEADS', targetValue: 10 } as any,
        'mgr-1',
      );
      // The target user is validated against the workspace first.
      expect(prisma.marketingUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'rep-1', workspaceId: WS } }),
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
          create: expect.objectContaining({ workspaceId: WS, targetValue: 10, setById: 'mgr-1' }),
          update: expect.objectContaining({ targetValue: 10, setById: 'mgr-1' }),
        }),
      );
    });

    it('404s a target user from another workspace (scoped lookup misses)', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue(null);
      await expect(
        svc.setTarget(
          WS,
          { marketingUserId: 'foreign-rep', period: '2026-06', metric: 'WON_LEADS', targetValue: 10 } as any,
          'mgr-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.salesTarget.upsert).not.toHaveBeenCalled();
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

      const perf = await svc.performanceFor(WS, 'rep-1', '2026-06');

      expect(perf).toEqual([
        { metric: 'WON_LEADS', target: 10, actual: 7, attainmentPct: 70 },
        { metric: 'COMMISSION_AMOUNT', target: 1000, actual: 750, attainmentPct: 75 },
        { metric: 'CONNECTED_CALLS', target: null, actual: 5, attainmentPct: null },
      ]);
      // Targets read is workspace-scoped.
      expect(prisma.salesTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: WS, marketingUserId: 'rep-1', period: '2026-06' },
        }),
      );
      // WON_LEADS actual is scoped to the workspace + rep + WON + the period window.
      expect(prisma.lead.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: WS,
            assignedToId: 'rep-1',
            status: 'WON',
          }),
        }),
      );
      // COMMISSION_AMOUNT uses the commission.period string directly.
      expect(prisma.commission.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: WS, marketingUserId: 'rep-1', period: '2026-06' },
        }),
      );
    });

    it('404s a rep from another workspace before computing anything', async () => {
      prisma.marketingUser.findFirst.mockResolvedValue(null);
      await expect(svc.performanceFor(WS, 'foreign-rep', '2026-06')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.salesTarget.findMany).not.toHaveBeenCalled();
    });

    it('excludes soft-deleted / merged leads from WON_LEADS (parity with the Performance Report)', async () => {
      // A WON lead that is later bulk-deleted (deletedAt set) must NOT keep
      // inflating attainment here while the Performance Report drops it.
      prisma.salesTarget.findMany.mockResolvedValue([] as any);
      prisma.lead.count.mockResolvedValue(0);
      (prisma.commission.aggregate as any).mockResolvedValue({ _sum: { amount: null } });
      prisma.salesCall.count.mockResolvedValue(0);
      await svc.performanceFor(WS, 'rep-1', '2026-06');
      expect(prisma.lead.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'WON',
            mergedIntoId: null,
            deletedAt: null,
          }),
        }),
      );
    });
  });

  describe('list', () => {
    it('scopes a REP to their own targets within the workspace', async () => {
      prisma.salesTarget.findMany.mockResolvedValue([]);
      await svc.list(WS, {}, { id: 'rep-1', role: 'REP' } as any);
      expect(prisma.salesTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, marketingUserId: 'rep-1' } }),
      );
    });

    it('lets a manager filter by rep + period', async () => {
      prisma.salesTarget.findMany.mockResolvedValue([]);
      await svc.list(
        WS,
        { marketingUserId: 'rep-9', period: '2026-06' },
        { id: 'mgr-1', role: 'MANAGER' } as any,
      );
      expect(prisma.salesTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: WS, marketingUserId: 'rep-9', period: '2026-06' },
        }),
      );
    });
  });

  describe('remove', () => {
    it('throws when the target is missing (or lives in another workspace)', async () => {
      prisma.salesTarget.findFirst.mockResolvedValue(null);
      await expect(svc.remove(WS, 'x')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.salesTarget.delete).not.toHaveBeenCalled();
    });

    it('deletes after a scoped pre-check', async () => {
      prisma.salesTarget.findFirst.mockResolvedValue({ id: 't-1' } as any);
      const res = await svc.remove(WS, 't-1');
      expect(prisma.salesTarget.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 't-1', workspaceId: WS } }),
      );
      expect(prisma.salesTarget.delete).toHaveBeenCalledWith({ where: { id: 't-1' } });
      expect(res).toEqual({ deleted: true });
    });
  });

  describe('teamPerformance', () => {
    // v3.0.1 round-4 — switched to batched groupBy queries instead of per-rep
    // findMany + aggregate + count, so the mocks return the pivoted shape.
    it('returns per-metric attainment for every active rep in the workspace', async () => {
      prisma.marketingUser.findMany.mockResolvedValue([
        { id: 'rep-1', firstName: 'Ada', lastName: 'Lovelace', role: 'REP' },
      ] as any);
      prisma.salesTarget.findMany.mockResolvedValue([
        { marketingUserId: 'rep-1', metric: 'WON_LEADS', targetValue: new Prisma.Decimal(5) },
      ] as any);
      (prisma.lead.groupBy as any).mockResolvedValue([
        { assignedToId: 'rep-1', _count: { _all: 4 } },
      ]);
      (prisma.commission.groupBy as any).mockResolvedValue([]);
      (prisma.salesCall.groupBy as any).mockResolvedValue([]);

      const team = await svc.teamPerformance(WS, '2026-06');

      expect(team).toHaveLength(1);
      expect(team[0].marketingUser.id).toBe('rep-1');
      expect(team[0].metrics).toHaveLength(3);
      expect(team[0].metrics.find((m) => m.metric === 'WON_LEADS')).toEqual({
        metric: 'WON_LEADS',
        target: 5,
        actual: 4,
        attainmentPct: 80,
      });
      // workspace + active filter is applied, and the internal SYSTEM research
      // sentinel is excluded so it never shows as a phantom zero-row in the
      // manager's team-performance table (it can never carry targets/deals).
      expect(prisma.marketingUser.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: WS, status: 'ACTIVE', role: { not: 'SYSTEM' } },
        }),
      );
      // batched aggregates are workspace-scoped too
      expect(prisma.lead.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
      );
    });

    it('excludes soft-deleted / merged leads from the team WON_LEADS aggregate', async () => {
      prisma.marketingUser.findMany.mockResolvedValue([
        { id: 'rep-1', firstName: 'Ada', lastName: 'Lovelace', role: 'REP' },
      ] as any);
      prisma.salesTarget.findMany.mockResolvedValue([] as any);
      (prisma.lead.groupBy as any).mockResolvedValue([]);
      (prisma.commission.groupBy as any).mockResolvedValue([]);
      (prisma.salesCall.groupBy as any).mockResolvedValue([]);
      await svc.teamPerformance(WS, '2026-06');
      expect(prisma.lead.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'WON',
            mergedIntoId: null,
            deletedAt: null,
          }),
        }),
      );
    });

    it('returns empty when no active reps (skip downstream queries)', async () => {
      prisma.marketingUser.findMany.mockResolvedValue([] as any);
      const team = await svc.teamPerformance(WS, '2026-06');
      expect(team).toEqual([]);
      // No fan-out fired.
      expect(prisma.lead.groupBy).not.toHaveBeenCalled();
      expect(prisma.commission.groupBy).not.toHaveBeenCalled();
      expect(prisma.salesCall.groupBy).not.toHaveBeenCalled();
    });
  });
});
