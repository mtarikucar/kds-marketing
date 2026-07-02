import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GamificationService } from './gamification.service';
import { mockPrismaClient } from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';
const P2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });

function makeSvc() {
  const prisma = mockPrismaClient();
  return { prisma, svc: new GamificationService(prisma as any) };
}

describe('GamificationService', () => {
  describe('award', () => {
    it('appends a ledger row (default points) then evaluates badges', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.pointsLedger.create as jest.Mock).mockResolvedValue({});
      prisma.badge.findMany.mockResolvedValue([] as any);
      await svc.award(WS, 'lead-1', 'LESSON_COMPLETE', 'l1');
      const data = (prisma.pointsLedger.create as jest.Mock).mock.calls[0][0].data;
      expect(data).toMatchObject({ workspaceId: WS, leadId: 'lead-1', source: 'LESSON_COMPLETE', refId: 'l1', points: 10 });
      expect(prisma.badge.findMany).toHaveBeenCalled();
    });

    it('is idempotent: a duplicate (lead, source, ref) is a no-op (no badge eval)', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.pointsLedger.create as jest.Mock).mockRejectedValue(P2002);
      await svc.award(WS, 'lead-1', 'LESSON_COMPLETE', 'l1');
      expect(prisma.badge.findMany).not.toHaveBeenCalled();
    });
  });

  describe('evaluateBadges', () => {
    function withMetrics(prisma: any, points: number, lessons: number, courses: number) {
      (prisma.pointsLedger.aggregate as jest.Mock).mockResolvedValue({ _sum: { points } });
      (prisma.pointsLedger.count as jest.Mock)
        .mockImplementation((a: any) => Promise.resolve(a.where.source === 'LESSON_COMPLETE' ? lessons : courses));
    }

    it('grants a POINTS badge whose threshold is met (and not one that is not)', async () => {
      const { prisma, svc } = makeSvc();
      prisma.badge.findMany.mockResolvedValue([
        { id: 'b1', ruleType: 'POINTS', threshold: 50 },
        { id: 'b2', ruleType: 'POINTS', threshold: 500 },
      ] as any);
      withMetrics(prisma, 100, 3, 1);
      (prisma.earnedBadge.create as jest.Mock).mockResolvedValue({});
      await svc.evaluateBadges(WS, 'lead-1');
      const granted = (prisma.earnedBadge.create as jest.Mock).mock.calls.map((c) => c[0].data.badgeId);
      expect(granted).toEqual(['b1']); // 100>=50 granted; 100<500 not
    });

    it('grants LESSONS/COURSES badges from the right metric', async () => {
      const { prisma, svc } = makeSvc();
      prisma.badge.findMany.mockResolvedValue([
        { id: 'bl', ruleType: 'LESSONS', threshold: 3 },
        { id: 'bc', ruleType: 'COURSES', threshold: 2 },
      ] as any);
      withMetrics(prisma, 100, 3, 1); // 3 lessons (met), 1 course (<2 not)
      (prisma.earnedBadge.create as jest.Mock).mockResolvedValue({});
      await svc.evaluateBadges(WS, 'lead-1');
      const granted = (prisma.earnedBadge.create as jest.Mock).mock.calls.map((c) => c[0].data.badgeId);
      expect(granted).toEqual(['bl']);
    });

    it('idempotent: an already-earned badge (P2002) is skipped silently', async () => {
      const { prisma, svc } = makeSvc();
      prisma.badge.findMany.mockResolvedValue([{ id: 'b1', ruleType: 'POINTS', threshold: 10 }] as any);
      withMetrics(prisma, 100, 3, 1);
      (prisma.earnedBadge.create as jest.Mock).mockRejectedValue(P2002);
      await expect(svc.evaluateBadges(WS, 'lead-1')).resolves.toBeUndefined();
    });
  });

  describe('leaderboard', () => {
    it('ranks leads by summed points and attaches names, excluding hidden leads via a JOIN', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.$queryRawUnsafe as any) = jest.fn().mockResolvedValue([
        { leadId: 'l1', points: 120 },
        { leadId: 'l2', points: 80 },
      ]);
      prisma.lead.findMany.mockResolvedValue([
        { id: 'l1', contactPerson: 'Ada', businessName: null },
        { id: 'l2', contactPerson: null, businessName: 'Acme' },
      ] as any);
      const out = await svc.leaderboard(WS, 1, 20);
      expect(out).toEqual([
        { rank: 1, leadId: 'l1', name: 'Ada', points: 120 },
        { rank: 2, leadId: 'l2', name: 'Acme', points: 80 },
      ]);
      // The raw query JOINs leads and excludes soft-deleted / merged members
      // BEFORE limit/offset, so a hidden lead never ranks or takes a page slot.
      const [sql, ws] = (prisma.$queryRawUnsafe as any).mock.calls[0];
      expect(sql).toContain('JOIN leads');
      expect(sql).toContain('"deletedAt" IS NULL');
      expect(sql).toContain('"mergedIntoId" IS NULL');
      expect(ws).toBe(WS);
      expect(prisma.lead.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: WS });
    });

    it('clamps pageSize and passes the computed skip to the query', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.$queryRawUnsafe as any) = jest.fn().mockResolvedValue([]);
      await svc.leaderboard(WS, 3, 999);
      const [, , take, skip] = (prisma.$queryRawUnsafe as any).mock.calls[0];
      expect(take).toBe(100); // clamped
      expect(skip).toBe(200); // (3-1)*100
    });
  });

  describe('badge admin', () => {
    it('createBadge retroactively grants to already-qualifying members', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.badge.create as jest.Mock).mockResolvedValue({ id: 'b1', ruleType: 'POINTS', threshold: 50 });
      (prisma.pointsLedger.groupBy as any).mockResolvedValue([
        { leadId: 'l1', _sum: { points: 120 } }, // qualifies
        { leadId: 'l2', _sum: { points: 10 } }, // does not
      ]);
      (prisma.earnedBadge.create as jest.Mock).mockResolvedValue({});
      await svc.createBadge(WS, { key: 'k', name: 'n', ruleType: 'POINTS', threshold: 50 });
      const granted = (prisma.earnedBadge.create as jest.Mock).mock.calls.map((c) => c[0].data.leadId);
      expect(granted).toEqual(['l1']);
    });

    // Badge.key is unique per (workspaceId, key) but createBadge has NO pre-check,
    // so even a SEQUENTIAL duplicate key would 500. Map P2002 to a clean 409.
    it('createBadge maps a duplicate key (P2002) to a 409', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.badge.create as jest.Mock).mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );
      await expect(
        svc.createBadge(WS, { key: 'dup', name: 'n', ruleType: 'POINTS', threshold: 50 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('backfillBadge for a LESSONS badge uses the lesson-count metric', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.pointsLedger.groupBy as any).mockResolvedValue([
        { leadId: 'l1', _count: { _all: 5 } }, // >=3 qualifies
        { leadId: 'l2', _count: { _all: 2 } }, // <3 not
      ]);
      (prisma.earnedBadge.create as jest.Mock).mockResolvedValue({});
      await svc.backfillBadge(WS, { id: 'b1', ruleType: 'LESSONS', threshold: 3 });
      const where = (prisma.pointsLedger.groupBy as any).mock.calls[0][0].where;
      expect(where).toEqual({ workspaceId: WS, source: 'LESSON_COMPLETE' });
      const granted = (prisma.earnedBadge.create as jest.Mock).mock.calls.map((c) => c[0].data.leadId);
      expect(granted).toEqual(['l1']);
    });

    it('updateBadge guards by workspace (updateMany), no backfill on a name-only change', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.badge.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      prisma.badge.findFirst.mockResolvedValue({ id: 'b1', name: 'New' } as any);
      const out: any = await svc.updateBadge(WS, 'b1', { name: 'New' });
      expect(prisma.badge.updateMany.mock.calls[0][0].where).toEqual({ id: 'b1', workspaceId: WS });
      expect(out).toMatchObject({ id: 'b1' });
      expect(prisma.pointsLedger.groupBy).not.toHaveBeenCalled(); // no rule change → no backfill
    });

    it('updateBadge backfills when the threshold changes', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.badge.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      prisma.badge.findFirst.mockResolvedValue({ id: 'b1', ruleType: 'POINTS', threshold: 20 } as any);
      (prisma.pointsLedger.groupBy as any).mockResolvedValue([{ leadId: 'l1', _sum: { points: 30 } }]);
      (prisma.earnedBadge.create as jest.Mock).mockResolvedValue({});
      await svc.updateBadge(WS, 'b1', { threshold: 20 });
      expect(prisma.pointsLedger.groupBy).toHaveBeenCalled();
      expect((prisma.earnedBadge.create as jest.Mock).mock.calls[0][0].data.leadId).toBe('l1');
    });

    it('deleteBadge removes the badge and its earned rows (scoped)', async () => {
      const { prisma, svc } = makeSvc();
      (prisma.badge.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.earnedBadge.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
      const out = await svc.deleteBadge(WS, 'b1');
      expect(out).toEqual({ id: 'b1' });
      expect(prisma.badge.deleteMany.mock.calls[0][0].where).toEqual({ id: 'b1', workspaceId: WS });
      expect(prisma.earnedBadge.deleteMany.mock.calls[0][0].where).toEqual({ badgeId: 'b1', workspaceId: WS });
    });
  });
});
