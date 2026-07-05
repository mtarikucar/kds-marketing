import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BudgetManagementService } from './budget-management.service';

function makePrisma(overrides: any = {}) {
  return {
    growthBudget: {
      upsert: jest.fn().mockResolvedValue({ id: 'b1' }),
      findFirst: jest.fn().mockResolvedValue({ id: 'b1' }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ id: 'b1' }),
      ...(overrides.growthBudget ?? {}),
    },
    budgetAllocation: { upsert: jest.fn().mockResolvedValue({ id: 'a1' }) },
    autopilotRun: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
}

describe('BudgetManagementService', () => {
  it('rejects a malformed periodKey', async () => {
    const svc = new BudgetManagementService(makePrisma());
    await expect(svc.upsertBudget('ws1', { periodKey: '2026-13', totalAmount: 100 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.upsertBudget('ws1', { periodKey: 'jully', totalAmount: 100 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an out-of-range explorationPct and negative total', async () => {
    const svc = new BudgetManagementService(makePrisma());
    await expect(svc.upsertBudget('ws1', { periodKey: '2026-07', totalAmount: 100, explorationPct: 95 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.upsertBudget('ws1', { periodKey: '2026-07', totalAmount: -1 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('upserts a budget on (workspace, period) with decimals + defaults', async () => {
    const prisma = makePrisma();
    const svc = new BudgetManagementService(prisma);
    await svc.upsertBudget('ws1', { periodKey: '2026-07', totalAmount: 30000, targetRoas: 2.5 });
    const arg = prisma.growthBudget.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ workspaceId_periodKey: { workspaceId: 'ws1', periodKey: '2026-07' } });
    expect(arg.create.scope).toBe('HOLISTIC');
    expect(arg.create.explorationPct).toBe(20);
    expect(arg.create.totalAmount.toString()).toBe('30000');
    expect(arg.create.targetRoas.toString()).toBe('2.5');
  });

  it('validates channel + amount on allocation upsert', async () => {
    const svc = new BudgetManagementService(makePrisma());
    await expect(svc.upsertAllocation('ws1', 'b1', { channel: 'BOGUS', plannedAmount: 10 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.upsertAllocation('ws1', 'b1', { channel: 'META', plannedAmount: -5 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('upserts an allocation on (budget, channel, campaignRef)', async () => {
    const prisma = makePrisma();
    const svc = new BudgetManagementService(prisma);
    await svc.upsertAllocation('ws1', 'b1', { channel: 'META', plannedAmount: 500 });
    const arg = prisma.budgetAllocation.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ budgetId_channel_campaignRef: { budgetId: 'b1', channel: 'META', campaignRef: '' } });
    expect(arg.create.plannedAmount.toString()).toBe('500');
  });

  it('404s a kill-switch on a budget owned by another workspace', async () => {
    const prisma = makePrisma({ growthBudget: { findFirst: jest.fn().mockResolvedValue(null) } });
    const svc = new BudgetManagementService(prisma);
    await expect(svc.setKillSwitch('ws1', 'b-other', true)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.growthBudget.update).not.toHaveBeenCalled();
  });
});

describe('BudgetManagementService.setAutonomyLevel (spec D6)', () => {
  function deps(budget: any = { id: 'b1', workspaceId: 'ws1' }) {
    const prisma = {
      growthBudget: {
        findFirst: jest.fn().mockResolvedValue(budget),
        update: jest.fn(async ({ data }: any) => ({ id: 'b1', ...data })),
      },
    } as any;
    return { prisma };
  }
  afterEach(() => { delete process.env.GROWTH_AUTOPILOT_AUTONOMY; });

  it('arms AUTONOMOUS only when the env flag is on', async () => {
    const { prisma } = deps();
    const { BudgetManagementService } = require('./budget-management.service');
    const svc = new BudgetManagementService(prisma);
    await expect(svc.setAutonomyLevel('ws1', 'b1', 'AUTONOMOUS')).rejects.toThrow();
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const r = await svc.setAutonomyLevel('ws1', 'b1', 'AUTONOMOUS');
    expect(r.autonomyLevel).toBe('AUTONOMOUS');
    expect(prisma.growthBudget.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { autonomyLevel: 'AUTONOMOUS' } });
  });

  it('rejects unknown levels and disarming stays available without the flag', async () => {
    const { prisma } = deps();
    const { BudgetManagementService } = require('./budget-management.service');
    const svc = new BudgetManagementService(prisma);
    await expect(svc.setAutonomyLevel('ws1', 'b1', 'YOLO')).rejects.toThrow();
    const r = await svc.setAutonomyLevel('ws1', 'b1', 'ASSISTED');
    expect(r.autonomyLevel).toBe('ASSISTED');
  });
});
