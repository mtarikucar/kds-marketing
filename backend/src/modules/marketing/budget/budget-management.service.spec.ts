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
