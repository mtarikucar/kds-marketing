import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('OpportunitiesService', () => {
  let prisma: MockPrismaClient;
  let pipelines: { get: jest.Mock; ensureDefaultPipeline: jest.Mock };
  let outbox: { append: jest.Mock };
  let svc: OpportunitiesService;

  const WS = 'ws-1';
  const REP = { id: 'rep-1', role: 'REP', workspaceId: WS } as any;
  const MGR = { id: 'mgr-1', role: 'MANAGER', workspaceId: WS } as any;

  const PIPELINE = {
    id: 'p1',
    name: 'Sales Pipeline',
    isDefault: true,
    stages: [
      { id: 's-new', name: 'New', position: 0, isWon: false, isLost: false },
      { id: 's-won', name: 'Won', position: 1, isWon: true, isLost: false },
      { id: 's-lost', name: 'Lost', position: 2, isWon: false, isLost: true },
    ],
  };

  beforeEach(() => {
    prisma = mockPrismaClient();
    pipelines = {
      get: jest.fn().mockResolvedValue(PIPELINE),
      ensureDefaultPipeline: jest.fn().mockResolvedValue(PIPELINE),
    };
    outbox = { append: jest.fn().mockResolvedValue('ob') };
    svc = new OpportunitiesService(prisma as any, pipelines as any, outbox as any);
    (prisma.$transaction as any).mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
  });

  describe('create', () => {
    it('opens a deal in the first stage and emits opportunity.created (rep owns it)', async () => {
      prisma.opportunity.create.mockResolvedValue({
        id: 'o1',
        pipelineId: 'p1',
        stageId: 's-new',
        leadId: null,
        assignedToId: REP.id,
        value: 0,
      } as any);

      await svc.create(WS, { name: 'Acme deal' } as any, REP);

      const arg = prisma.opportunity.create.mock.calls[0][0] as any;
      expect(arg.data).toMatchObject({
        workspaceId: WS,
        pipelineId: 'p1',
        stageId: 's-new',
        status: 'OPEN',
        assignedToId: REP.id, // rep forced to self
      });
      expect(outbox.append.mock.calls[0][0]).toMatchObject({
        type: 'marketing.opportunity.created.v1',
        idempotencyKey: 'opp-created:o1',
      });
    });

    it('lands as WON with wonAt when created directly in a win stage', async () => {
      prisma.opportunity.create.mockResolvedValue({ id: 'o2', value: 100 } as any);
      await svc.create(WS, { name: 'Quick win', stageId: 's-won', value: 100 } as any, MGR);
      const arg = prisma.opportunity.create.mock.calls[0][0] as any;
      expect(arg.data.status).toBe('WON');
      expect(arg.data.wonAt).toBeInstanceOf(Date);
    });

    it('rejects a stageId that is not in the pipeline', async () => {
      await expect(
        svc.create(WS, { name: 'x', stageId: 's-bogus' } as any, MGR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('validates a linked lead lives in the workspace', async () => {
      prisma.lead.findFirst.mockResolvedValue(null);
      await expect(
        svc.create(WS, { name: 'x', leadId: 'lead-x' } as any, MGR),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'lead-x', workspaceId: WS } }),
      );
    });
  });

  describe('getScoped / get', () => {
    it("forbids a REP from reading another rep's opportunity", async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: WS,
        assignedToId: 'other-rep',
      } as any);
      await expect(svc.get(WS, 'o1', REP)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s an opportunity from another workspace', async () => {
      prisma.opportunity.findFirst.mockResolvedValue(null);
      await expect(svc.get(WS, 'o1', MGR)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('move', () => {
    it('resolves the deal WON and emits stage_changed + won when dropped in a win stage', async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: WS,
        pipelineId: 'p1',
        stageId: 's-new',
        assignedToId: MGR.id,
        wonAt: null,
        lostAt: null,
      } as any);
      prisma.pipelineStage.findFirst.mockResolvedValue({
        id: 's-won',
        isWon: true,
        isLost: false,
      } as any);
      prisma.opportunity.update.mockResolvedValue({ id: 'o1', value: 500, status: 'WON' } as any);

      await svc.move(WS, 'o1', { stageId: 's-won' } as any, MGR);

      const arg = prisma.opportunity.update.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 'o1' });
      expect(arg.data.status).toBe('WON');
      expect(arg.data.wonAt).toBeInstanceOf(Date);
      const types = outbox.append.mock.calls.map((c) => c[0].type);
      expect(types).toContain('marketing.opportunity.stage_changed.v1');
      expect(types).toContain('marketing.opportunity.won.v1');
    });

    it('404s when the target stage is not in the deal pipeline', async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'o1',
        workspaceId: WS,
        pipelineId: 'p1',
        stageId: 's-new',
        assignedToId: MGR.id,
      } as any);
      prisma.pipelineStage.findFirst.mockResolvedValue(null);
      await expect(
        svc.move(WS, 'o1', { stageId: 's-other' } as any, MGR),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.pipelineStage.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's-other', workspaceId: WS, pipelineId: 'p1' },
        }),
      );
    });
  });

  describe('list', () => {
    it('hard-scopes a REP to their own opportunities within the workspace', async () => {
      prisma.opportunity.findMany.mockResolvedValue([]);
      prisma.opportunity.count.mockResolvedValue(0 as any);

      await svc.list(WS, {} as any, REP);

      expect(prisma.opportunity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspaceId: WS, assignedToId: REP.id }),
        }),
      );
    });
  });

  describe('board', () => {
    it('groups OPEN cards under their stage with per-stage totals (rep-scoped)', async () => {
      prisma.opportunity.findMany.mockResolvedValue([
        { id: 'o1', stageId: 's-new', value: 100 },
        { id: 'o2', stageId: 's-new', value: 50 },
      ] as any);

      const res = await svc.board(WS, 'p1', REP);

      expect(prisma.opportunity.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: WS,
            pipelineId: 'p1',
            status: 'OPEN',
            assignedToId: REP.id,
          }),
        }),
      );
      const newCol = res.stages.find((s: any) => s.id === 's-new');
      expect(newCol.count).toBe(2);
      expect(newCol.totalValue).toBe(150);
    });
  });
});
