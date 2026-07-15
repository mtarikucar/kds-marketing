import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PipelinesService } from './pipelines.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('PipelinesService', () => {
  let prisma: MockPrismaClient;
  let svc: PipelinesService;
  const WS = 'ws-1';

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new PipelinesService(prisma as any);
    (prisma.$transaction as any).mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
  });

  describe('ensureDefaultPipeline', () => {
    it('seeds a default pipeline + 6 stages when the workspace has none', async () => {
      prisma.pipeline.findFirst.mockResolvedValue(null);
      prisma.pipeline.create.mockResolvedValue({ id: 'p1', stages: [] } as any);

      await svc.ensureDefaultPipeline(WS);

      const arg = prisma.pipeline.create.mock.calls[0][0] as any;
      expect(arg.data.workspaceId).toBe(WS);
      expect(arg.data.isDefault).toBe(true);
      expect(arg.data.stages.create).toHaveLength(6);
      // Every seeded stage carries the workspace id and a terminal Won/Lost pair.
      expect(arg.data.stages.create.every((s: any) => s.workspaceId === WS)).toBe(true);
      expect(arg.data.stages.create.some((s: any) => s.isWon)).toBe(true);
      expect(arg.data.stages.create.some((s: any) => s.isLost)).toBe(true);
    });

    it('returns the existing pipeline without seeding when one exists', async () => {
      prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1', stages: [] } as any);
      const res = await svc.ensureDefaultPipeline(WS);
      expect(res).toMatchObject({ id: 'p1' });
      expect(prisma.pipeline.create).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('unsets other defaults when creating a new default pipeline (scoped)', async () => {
      prisma.pipeline.updateMany.mockResolvedValue({ count: 1 } as any);
      prisma.pipeline.create.mockResolvedValue({ id: 'p2', stages: [] } as any);

      await svc.create(WS, { name: 'Enterprise', isDefault: true } as any);

      expect(prisma.pipeline.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId: WS, isDefault: true },
          data: { isDefault: false },
        }),
      );
      const arg = prisma.pipeline.create.mock.calls[0][0] as any;
      expect(arg.data.workspaceId).toBe(WS);
      // Falls back to default stages when none supplied.
      expect(arg.data.stages.create.length).toBeGreaterThan(0);
    });
  });

  describe('remove', () => {
    it('refuses to delete a pipeline that still holds opportunities (any status)', async () => {
      prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1', stages: [] } as any);
      prisma.opportunity.count.mockResolvedValue(3 as any);

      await expect(svc.remove(WS, 'p1')).rejects.toBeInstanceOf(ConflictException);
      // The guard counts ALL statuses, not just OPEN — Opportunity→Pipeline is
      // onDelete:Cascade, so a status-scoped guard would let a delete cascade
      // away historical WON/LOST deals.
      expect(prisma.opportunity.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, pipelineId: 'p1' } }),
      );
      expect(prisma.pipeline.delete).not.toHaveBeenCalled();
    });

    it('refuses when only CLOSED (won/lost) deals remain — cascade would destroy history', async () => {
      prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1', stages: [] } as any);
      // 0 OPEN deals, but 5 closed (won/lost) ones. A guard scoped to OPEN would
      // see 0 and let the cascade delete those 5 sales records.
      (prisma.opportunity.count as any).mockImplementation(({ where }: any) =>
        Promise.resolve(where.status === undefined ? 5 : 0),
      );

      await expect(svc.remove(WS, 'p1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.pipeline.delete).not.toHaveBeenCalled();
    });

    it('deletes when no opportunities remain at all', async () => {
      prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1', stages: [] } as any);
      prisma.opportunity.count.mockResolvedValue(0 as any);
      await svc.remove(WS, 'p1');
      expect(prisma.pipeline.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    });

    it('404s a pipeline from another workspace', async () => {
      prisma.pipeline.findFirst.mockResolvedValue(null);
      await expect(svc.remove(WS, 'p-x')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateStage — won/lost re-typing guard', () => {
    it('refuses to flip isWon/isLost while the stage holds deals (would desync their status)', async () => {
      prisma.pipelineStage.findFirst.mockResolvedValue({ id: 's1', isWon: false, isLost: false } as any);
      prisma.opportunity.count.mockResolvedValue(5 as any);
      await expect(svc.updateStage(WS, 'p1', 's1', { isWon: true } as any)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.pipelineStage.update).not.toHaveBeenCalled();
    });

    it('allows flipping isWon when the stage is empty', async () => {
      prisma.pipelineStage.findFirst.mockResolvedValue({ id: 's1', isWon: false, isLost: false } as any);
      prisma.opportunity.count.mockResolvedValue(0 as any);
      (prisma.pipelineStage.update as any).mockResolvedValue({ id: 's1' });
      await svc.updateStage(WS, 'p1', 's1', { isWon: true } as any);
      expect(prisma.pipelineStage.update).toHaveBeenCalled();
    });

    it('allows editing name/probability with deals present (no won/lost change → no guard)', async () => {
      prisma.pipelineStage.findFirst.mockResolvedValue({ id: 's1', isWon: false, isLost: false } as any);
      (prisma.pipelineStage.update as any).mockResolvedValue({ id: 's1' });
      await svc.updateStage(WS, 'p1', 's1', { name: 'Renamed', probability: 40 } as any);
      expect(prisma.opportunity.count).not.toHaveBeenCalled();
      expect(prisma.pipelineStage.update).toHaveBeenCalled();
    });
  });

  describe('addStage — position from max+1 (no post-delete collision)', () => {
    it('appends AFTER the last surviving stage, not at count() (which collides after a delete)', async () => {
      prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1', stages: [] } as any);
      // Survivors at 0,1,3,4,5 (a middle stage was deleted) → count()=5 would
      // COLLIDE with the stage already at 5; max+1 must land at 6.
      (prisma.pipelineStage.aggregate as any).mockResolvedValue({ _max: { position: 5 } });
      (prisma.pipelineStage.create as any).mockImplementation((a: any) => Promise.resolve({ id: 'new', ...a.data }));
      const out: any = await svc.addStage(WS, 'p1', { name: 'Demo' } as any);
      expect(out.position).toBe(6);
    });

    it('appends the first stage at position 0 on an empty pipeline', async () => {
      prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1', stages: [] } as any);
      (prisma.pipelineStage.aggregate as any).mockResolvedValue({ _max: { position: null } });
      (prisma.pipelineStage.create as any).mockImplementation((a: any) => Promise.resolve({ id: 'new', ...a.data }));
      const out: any = await svc.addStage(WS, 'p1', { name: 'New' } as any);
      expect(out.position).toBe(0);
    });
  });

  describe('removeStage', () => {
    it('refuses while the stage still holds opportunities', async () => {
      prisma.pipelineStage.findFirst.mockResolvedValue({ id: 's1' } as any);
      prisma.opportunity.count.mockResolvedValue(2 as any);
      await expect(svc.removeStage(WS, 'p1', 's1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to drop the last stage', async () => {
      prisma.pipelineStage.findFirst.mockResolvedValue({ id: 's1' } as any);
      prisma.opportunity.count.mockResolvedValue(0 as any);
      prisma.pipelineStage.count.mockResolvedValue(1 as any);
      await expect(svc.removeStage(WS, 'p1', 's1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('deletes AND closes the position gap so survivors stay dense 0..n-1', async () => {
      prisma.pipelineStage.findFirst.mockResolvedValue({ id: 's2', position: 2 } as any);
      prisma.opportunity.count.mockResolvedValue(0 as any);
      prisma.pipelineStage.count.mockResolvedValue(4 as any);
      (prisma.$transaction as any).mockResolvedValue([]);
      (prisma.pipelineStage.delete as any).mockResolvedValue({ id: 's2' });
      (prisma.pipelineStage.updateMany as any).mockResolvedValue({ count: 3 });

      await svc.removeStage(WS, 'p1', 's2');

      // Positions ABOVE the deleted stage shift down by one, closing the gap.
      expect(prisma.pipelineStage.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: WS, pipelineId: 'p1', position: { gt: 2 } },
        data: { position: { decrement: 1 } },
      });
    });
  });

  describe('reorderStages', () => {
    it('rejects a list that does not cover every stage exactly once', async () => {
      prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1', stages: [] } as any);
      prisma.pipelineStage.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }] as any);
      await expect(svc.reorderStages(WS, 'p1', ['a'])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.reorderStages(WS, 'p1', ['a', 'a'])).rejects.toBeInstanceOf(BadRequestException);
    });

    it('persists new positions scoped to the workspace+pipeline', async () => {
      prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1', stages: [] } as any);
      prisma.pipelineStage.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }] as any);
      prisma.pipelineStage.updateMany.mockResolvedValue({ count: 1 } as any);

      await svc.reorderStages(WS, 'p1', ['b', 'a']);

      expect(prisma.pipelineStage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'b', workspaceId: WS, pipelineId: 'p1' },
          data: { position: 0 },
        }),
      );
    });
  });
});
