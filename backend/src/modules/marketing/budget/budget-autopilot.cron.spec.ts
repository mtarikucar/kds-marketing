import { BudgetAutopilotCron } from './budget-autopilot.cron';

function makeDeps(budgets: any[]) {
  const prisma = { growthBudget: { findMany: jest.fn().mockResolvedValue(budgets) } } as any;
  const pacer = { tick: jest.fn().mockResolvedValue({}) } as any;
  const autopilot = { propose: jest.fn().mockResolvedValue({ status: 'PROPOSED' }) } as any;
  const performanceLoop = { reconcile: jest.fn().mockResolvedValue({}) } as any;
  const mirror = { mirrorForBudget: jest.fn().mockResolvedValue({ mirrored: 0, governorDebits: 0 }) } as any;
  const anomaly = { evaluate: jest.fn().mockResolvedValue({ tripped: false }) } as any;
  return { prisma, pacer, autopilot, performanceLoop, mirror, anomaly };
}

function makeCron(d: ReturnType<typeof makeDeps>) {
  return new BudgetAutopilotCron(d.prisma, d.pacer, d.autopilot, d.performanceLoop, d.mirror, d.anomaly);
}

describe('BudgetAutopilotCron', () => {
  it('is a no-op when there are no active budgets (self-gating)', async () => {
    const deps = makeDeps([]);
    const { prisma, pacer, autopilot, performanceLoop } = deps;
    const cron = makeCron(deps);
    expect(await cron.runAll()).toBe(0);
    expect(pacer.tick).not.toHaveBeenCalled();
    // only active, non-killed budgets are selected
    expect(prisma.growthBudget.findMany.mock.calls[0][0].where).toEqual({ status: 'ACTIVE', killSwitch: false });
  });

  it('paces then shadow-proposes each active budget', async () => {
    const deps = makeDeps([
      { id: 'b1', workspaceId: 'ws1' },
      { id: 'b2', workspaceId: 'ws2' },
    ]);
    const { prisma, pacer, autopilot, performanceLoop } = deps;
    const cron = makeCron(deps);
    const now = new Date('2026-07-16T00:00:00Z');
    expect(await cron.runAll(now)).toBe(2);
    expect(pacer.tick).toHaveBeenCalledWith('ws1', 'b1', now);
    expect(autopilot.propose).toHaveBeenCalledWith('ws1', 'b1', now);
    expect(autopilot.propose).toHaveBeenCalledWith('ws2', 'b2', now);
  });

  it('reconciles first-party revenue once per distinct workspace before proposing', async () => {
    const deps = makeDeps([
      { id: 'b1', workspaceId: 'ws1' },
      { id: 'b2', workspaceId: 'ws1' }, // same workspace, two budgets
      { id: 'b3', workspaceId: 'ws2' },
    ]);
    const { prisma, pacer, autopilot, performanceLoop } = deps;
    const cron = makeCron(deps);
    await cron.runAll(new Date('2026-07-16T00:00:00Z'));
    // ws1 + ws2 => 2 reconciles, not 3
    expect(performanceLoop.reconcile).toHaveBeenCalledTimes(2);
  });

  it('keeps going past a budget that throws', async () => {
    const deps = makeDeps([
      { id: 'b1', workspaceId: 'ws1' },
      { id: 'b2', workspaceId: 'ws2' },
    ]);
    const { prisma, pacer, autopilot, performanceLoop } = deps;
    pacer.tick.mockRejectedValueOnce(new Error('boom'));
    const cron = makeCron(deps);
    expect(await cron.runAll()).toBe(1); // b1 failed, b2 succeeded
    expect(autopilot.propose).toHaveBeenCalledTimes(1);
  });

  it('anomaly trip pauses that budget for the tick: mirror runs, pacer/propose are skipped', async () => {
    const deps = makeDeps([
      { id: 'b1', workspaceId: 'ws1' },
      { id: 'b2', workspaceId: 'ws1' },
    ]);
    deps.anomaly.evaluate.mockImplementation(async (_ws: string, b: any) => ({ tripped: b.id === 'b1', reason: 'velocity' }));
    const cron = makeCron(deps);

    const n = await cron.runAll();

    expect(deps.mirror.mirrorForBudget).toHaveBeenCalledTimes(2); // spend truth always mirrored first
    expect(deps.pacer.tick).toHaveBeenCalledTimes(1);
    expect(deps.pacer.tick).toHaveBeenCalledWith('ws1', 'b2', expect.any(Date));
    expect(deps.autopilot.propose).toHaveBeenCalledTimes(1);
    expect(n).toBe(1);
  });

});