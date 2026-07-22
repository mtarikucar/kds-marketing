import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StrategyService } from './strategy.service';

function deps(overrides: { strategy?: any; action?: any } = {}) {
  const prisma = {
    marketingStrategy: {
      findUnique: jest.fn().mockResolvedValue(overrides.strategy ?? null),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'strat1', ...data })),
    },
    strategyAction: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(overrides.action ?? null),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
  };
  const orchestrator = { execute: jest.fn().mockResolvedValue({ status: 'DONE', resultRef: null }) };
  const svc = new StrategyService(prisma as any, orchestrator as any);
  return { svc, prisma, orchestrator };
}

const action = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'a1',
  workspaceId: 'ws1',
  strategyId: 'strat1',
  kind: 'CONTENT',
  status: 'PROPOSED',
  priority: 'MEDIUM',
  ...over,
});

describe('StrategyService', () => {
  describe('getStrategy', () => {
    it('returns the workspace strategy', async () => {
      const { svc, prisma } = deps({ strategy: { id: 'strat1', workspaceId: 'ws1' } });
      expect(await svc.getStrategy('ws1')).toEqual({ id: 'strat1', workspaceId: 'ws1' });
      expect(prisma.marketingStrategy.findUnique).toHaveBeenCalledWith({ where: { workspaceId: 'ws1' } });
    });

    it('returns null when none exists', async () => {
      const { svc } = deps();
      expect(await svc.getStrategy('ws1')).toBeNull();
    });
  });

  describe('listActions', () => {
    it('scopes to the workspace and passes the status filter through', async () => {
      const { svc, prisma } = deps();
      await svc.listActions('ws1', { status: 'PROPOSED' });
      expect(prisma.strategyAction.findMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws1', status: 'PROPOSED' },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('omits the status filter when not given', async () => {
      const { svc, prisma } = deps();
      await svc.listActions('ws1');
      expect(prisma.strategyAction.findMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws1' },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('orders by priority HIGH → MEDIUM → LOW', async () => {
      const { svc, prisma } = deps();
      prisma.strategyAction.findMany.mockResolvedValue([
        action({ id: 'low', priority: 'LOW' }),
        action({ id: 'high', priority: 'HIGH' }),
        action({ id: 'med', priority: 'MEDIUM' }),
      ]);
      const r = await svc.listActions('ws1');
      expect(r.map((a) => a.id)).toEqual(['high', 'med', 'low']);
    });
  });

  describe('approveAction', () => {
    it('flips PROPOSED → APPROVED then dispatches the action to the orchestrator', async () => {
      const { svc, prisma, orchestrator } = deps({ action: action({ status: 'PROPOSED' }) });
      const r = await svc.approveAction('ws1', 'a1');
      expect(prisma.strategyAction.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { status: 'APPROVED' } });
      expect(orchestrator.execute).toHaveBeenCalledWith('ws1', 'a1');
      expect(r.status).toBe('APPROVED');
    });

    it('still resolves (approval stands) when the orchestrator dispatch throws', async () => {
      const { svc, orchestrator } = deps({ action: action({ status: 'PROPOSED' }) });
      orchestrator.execute.mockRejectedValueOnce(new Error('dispatch boom'));
      const r = await svc.approveAction('ws1', 'a1');
      expect(r.status).toBe('APPROVED');
    });

    it('throws NotFound when the action is missing/other-workspace', async () => {
      const { svc, orchestrator } = deps({ action: null });
      await expect(svc.approveAction('ws1', 'nope')).rejects.toThrow(NotFoundException);
      expect(orchestrator.execute).not.toHaveBeenCalled();
    });

    it('throws BadRequest when the action is not PROPOSED and does not dispatch', async () => {
      const { svc, prisma, orchestrator } = deps({ action: action({ status: 'APPROVED' }) });
      await expect(svc.approveAction('ws1', 'a1')).rejects.toThrow(BadRequestException);
      expect(prisma.strategyAction.update).not.toHaveBeenCalled();
      expect(orchestrator.execute).not.toHaveBeenCalled();
    });
  });

  describe('dismissAction', () => {
    it('flips a PROPOSED action → DISMISSED', async () => {
      const { svc, prisma } = deps({ action: action({ status: 'PROPOSED' }) });
      const r = await svc.dismissAction('ws1', 'a1');
      expect(prisma.strategyAction.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { status: 'DISMISSED' } });
      expect(r.status).toBe('DISMISSED');
    });

    it('dismisses an APPROVED action too', async () => {
      const { svc } = deps({ action: action({ status: 'APPROVED' }) });
      expect((await svc.dismissAction('ws1', 'a1')).status).toBe('DISMISSED');
    });

    it('throws NotFound when missing/other-workspace', async () => {
      const { svc } = deps({ action: null });
      await expect(svc.dismissAction('ws1', 'nope')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when already terminal (DONE)', async () => {
      const { svc, prisma } = deps({ action: action({ status: 'DONE' }) });
      await expect(svc.dismissAction('ws1', 'a1')).rejects.toThrow(BadRequestException);
      expect(prisma.strategyAction.update).not.toHaveBeenCalled();
    });
  });

  describe('setAutonomy', () => {
    it('updates the autonomy level for a valid enum', async () => {
      const { svc, prisma } = deps({ strategy: { id: 'strat1', workspaceId: 'ws1' } });
      const r = await svc.setAutonomy('ws1', 'AUTONOMOUS');
      expect(prisma.marketingStrategy.update).toHaveBeenCalledWith({
        where: { workspaceId: 'ws1' },
        data: { autonomyLevel: 'AUTONOMOUS' },
      });
      expect(r.autonomyLevel).toBe('AUTONOMOUS');
    });

    it('throws BadRequest for an invalid level', async () => {
      const { svc, prisma } = deps({ strategy: { id: 'strat1' } });
      await expect(svc.setAutonomy('ws1', 'YOLO')).rejects.toThrow(BadRequestException);
      expect(prisma.marketingStrategy.update).not.toHaveBeenCalled();
    });

    it('throws NotFound when the workspace has no strategy', async () => {
      const { svc } = deps({ strategy: null });
      await expect(svc.setAutonomy('ws1', 'SHADOW')).rejects.toThrow(NotFoundException);
    });
  });
});
