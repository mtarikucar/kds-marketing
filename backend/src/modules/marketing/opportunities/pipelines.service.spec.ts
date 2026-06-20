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
    it('refuses to delete a pipeline that still has open opportunities', async () => {
      prisma.pipeline.findFirst.mockResolvedValue({ id: 'p1', stages: [] } as any);
      prisma.opportunity.count.mockResolvedValue(3 as any);

      await expect(svc.remove(WS, 'p1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.opportunity.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS, pipelineId: 'p1', status: 'OPEN' } }),
      );
      expect(prisma.pipeline.delete).not.toHaveBeenCalled();
    });

    it('deletes when no open opportunities remain', async () => {
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
