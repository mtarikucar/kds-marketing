import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { BudgetAutopilotService } from './budget-autopilot.service';

const D = (n: number) => new Prisma.Decimal(n);

function makeDeps(budget: any) {
  const create = jest.fn().mockResolvedValue({ id: 'run-1' });
  const prisma = {
    growthBudget: { findFirst: jest.fn().mockResolvedValue(budget) },
    autopilotRun: { create },
  } as any;
  const perf = { collect: jest.fn() } as any;
  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const approvals = { enqueue } as any;
  return { prisma, perf, approvals, enqueue, create };
}

const baseAllocs = [
  { channel: 'META', campaignRef: '', plannedAmount: D(100) },
  { channel: 'GOOGLE', campaignRef: '', plannedAmount: D(100) },
];

describe('BudgetAutopilotService (shadow)', () => {
  it('throws when the budget does not exist', async () => {
    const { prisma, perf, approvals } = makeDeps(null);
    const svc = new BudgetAutopilotService(prisma, perf, approvals);
    await expect(svc.propose('ws1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('skips (records a SKIPPED run) when the kill-switch is on and never gathers perf', async () => {
    const { prisma, perf, approvals, create } = makeDeps({
      id: 'b1', workspaceId: 'ws1', status: 'ACTIVE', killSwitch: true,
      totalAmount: D(1000), explorationPct: 20, targetRoas: null, allocations: baseAllocs,
    });
    const svc = new BudgetAutopilotService(prisma, perf, approvals);
    const r = await svc.propose('ws1', 'b1');
    expect(r.status).toBe('SKIPPED');
    expect(r.reason).toBe('kill-switch');
    expect(perf.collect).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.ok).toBe(false);
  });

  it('proposes a SHADOW reallocation and never executes a real write', async () => {
    const { prisma, perf, approvals, create } = makeDeps({
      id: 'b1', workspaceId: 'ws1', status: 'ACTIVE', killSwitch: false,
      totalAmount: D(200), explorationPct: 0, targetRoas: null, allocations: baseAllocs,
    });
    perf.collect.mockResolvedValue([
      { channel: 'META', campaignRef: '', currentBudget: 100, spend: 100, revenue: 400 },
      { channel: 'GOOGLE', campaignRef: '', currentBudget: 100, spend: 100, revenue: 150 },
    ]);
    const svc = new BudgetAutopilotService(prisma, perf, approvals);
    const r = await svc.propose('ws1', 'b1');

    expect(r.status).toBe('PROPOSED');
    expect(r.plan).toBeDefined();
    // higher-ROAS META keeps the bigger slice
    const meta = r.plan!.allocations.find((a) => a.channel === 'META')!;
    const google = r.plan!.allocations.find((a) => a.channel === 'GOOGLE')!;
    expect(meta.after).toBeGreaterThan(google.after);

    // the run is recorded as SHADOW (dry-run) — the only side effect
    const runData = create.mock.calls[0][0].data;
    expect(runData.autonomy).toBe('SHADOW');
    expect(runData.kind).toBe('REALLOCATION');
    expect(runData.ok).toBe(true);
    expect(runData.after).toBeDefined();

    // a material proposal enqueues a human approval (the bridge to execution)
    expect(r.approvalId).toBe('appr-1');
    expect(approvals.enqueue).toHaveBeenCalledWith('ws1', expect.objectContaining({ kind: 'BUDGET_REALLOCATION' }));
  });

  it('respects a target ROAS floor from the budget (holds when nothing clears it)', async () => {
    const { prisma, perf, approvals } = makeDeps({
      id: 'b1', workspaceId: 'ws1', status: 'ACTIVE', killSwitch: false,
      totalAmount: D(1000), explorationPct: 0, targetRoas: D(5), allocations: baseAllocs,
    });
    perf.collect.mockResolvedValue([
      { channel: 'META', campaignRef: '', currentBudget: 100, spend: 100, revenue: 200 }, // ROAS 2 < 5
      { channel: 'GOOGLE', campaignRef: '', currentBudget: 100, spend: 100, revenue: 300 }, // ROAS 3 < 5
    ]);
    const svc = new BudgetAutopilotService(prisma, perf, approvals);
    const r = await svc.propose('ws1', 'b1');
    expect(r.plan!.allocations.every((a) => a.after === a.before)).toBe(true);
    // a noop plan enqueues nothing
    expect(approvals.enqueue).not.toHaveBeenCalled();
    expect(r.approvalId).toBeUndefined();
  });
});
