import { BudgetAutopilotCron } from './budget-autopilot.cron';

function makeDeps(budgets: any[]) {
  const prisma = { growthBudget: { findMany: jest.fn().mockResolvedValue(budgets) } } as any;
  const pacer = { tick: jest.fn().mockResolvedValue({}) } as any;
  const autopilot = { propose: jest.fn().mockResolvedValue({ status: 'PROPOSED' }) } as any;
  const performanceLoop = { reconcile: jest.fn().mockResolvedValue({}) } as any;
  return { prisma, pacer, autopilot, performanceLoop };
}

describe('BudgetAutopilotCron', () => {
  it('is a no-op when there are no active budgets (self-gating)', async () => {
    const { prisma, pacer, autopilot, performanceLoop } = makeDeps([]);
    const cron = new BudgetAutopilotCron(prisma, pacer, autopilot, performanceLoop);
    expect(await cron.runAll()).toBe(0);
    expect(pacer.tick).not.toHaveBeenCalled();
    // only active, non-killed budgets are selected
    expect(prisma.growthBudget.findMany.mock.calls[0][0].where).toEqual({ status: 'ACTIVE', killSwitch: false });
  });

  it('paces then shadow-proposes each active budget', async () => {
    const { prisma, pacer, autopilot, performanceLoop } = makeDeps([
      { id: 'b1', workspaceId: 'ws1' },
      { id: 'b2', workspaceId: 'ws2' },
    ]);
    const cron = new BudgetAutopilotCron(prisma, pacer, autopilot, performanceLoop);
    const now = new Date('2026-07-16T00:00:00Z');
    expect(await cron.runAll(now)).toBe(2);
    expect(pacer.tick).toHaveBeenCalledWith('ws1', 'b1', now);
    expect(autopilot.propose).toHaveBeenCalledWith('ws1', 'b1', now);
    expect(autopilot.propose).toHaveBeenCalledWith('ws2', 'b2', now);
  });

  it('reconciles first-party revenue once per distinct workspace before proposing', async () => {
    const { prisma, pacer, autopilot, performanceLoop } = makeDeps([
      { id: 'b1', workspaceId: 'ws1' },
      { id: 'b2', workspaceId: 'ws1' }, // same workspace, two budgets
      { id: 'b3', workspaceId: 'ws2' },
    ]);
    const cron = new BudgetAutopilotCron(prisma, pacer, autopilot, performanceLoop);
    await cron.runAll(new Date('2026-07-16T00:00:00Z'));
    // ws1 + ws2 => 2 reconciles, not 3
    expect(performanceLoop.reconcile).toHaveBeenCalledTimes(2);
  });

  it('keeps going past a budget that throws', async () => {
    const { prisma, pacer, autopilot, performanceLoop } = makeDeps([
      { id: 'b1', workspaceId: 'ws1' },
      { id: 'b2', workspaceId: 'ws2' },
    ]);
    pacer.tick.mockRejectedValueOnce(new Error('boom'));
    const cron = new BudgetAutopilotCron(prisma, pacer, autopilot, performanceLoop);
    expect(await cron.runAll()).toBe(1); // b1 failed, b2 succeeded
    expect(autopilot.propose).toHaveBeenCalledTimes(1);
  });
});
