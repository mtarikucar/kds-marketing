import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { BudgetAutopilotService } from './budget-autopilot.service';

const D = (n: number) => new Prisma.Decimal(n);

function makeDeps(budget: any) {
  const create = jest.fn().mockResolvedValue({ id: 'run-1' });
  const prisma = {
    growthBudget: { findFirst: jest.fn().mockResolvedValue(budget) },
    autopilotRun: { create, findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const perf = { collect: jest.fn() } as any;
  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const approvals = { enqueue } as any;
  const executor = { applyAutonomous: jest.fn().mockResolvedValue({ status: 'APPLIED', applied: 1, skipped: 0, results: [] }) } as any;
  const wallet = {
    balance: jest.fn().mockResolvedValue(D(0)),
    governorDebited: jest.fn().mockResolvedValue(D(0)),
  } as any;
  const ledger = { netSpent: jest.fn().mockResolvedValue(D(0)) } as any;
  return { prisma, perf, approvals, enqueue, create, executor, wallet, ledger };
}

function makeSvc(d: ReturnType<typeof makeDeps>) {
  return new BudgetAutopilotService(d.prisma, d.perf, d.approvals, d.executor, d.wallet, d.ledger);
}

const baseAllocs = [
  { channel: 'META', campaignRef: '', plannedAmount: D(100) },
  { channel: 'GOOGLE', campaignRef: '', plannedAmount: D(100) },
];

describe('BudgetAutopilotService (shadow)', () => {
  it('throws when the budget does not exist', async () => {
    const { prisma, perf, approvals } = makeDeps(null);
    const svc = makeSvc({ prisma, perf, approvals } as any);
    await expect(svc.propose('ws1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('skips (records a SKIPPED run) when the kill-switch is on and never gathers perf', async () => {
    const { prisma, perf, approvals, create } = makeDeps({
      id: 'b1', workspaceId: 'ws1', status: 'ACTIVE', killSwitch: true,
      totalAmount: D(1000), explorationPct: 20, targetRoas: null, allocations: baseAllocs,
    });
    const svc = makeSvc({ prisma, perf, approvals } as any);
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
    const svc = makeSvc({ prisma, perf, approvals } as any);
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
    const svc = makeSvc({ prisma, perf, approvals } as any);
    const r = await svc.propose('ws1', 'b1');
    expect(r.plan!.allocations.every((a) => a.after === a.before)).toBe(true);
    // a noop plan enqueues nothing
    expect(approvals.enqueue).not.toHaveBeenCalled();
    expect(r.approvalId).toBeUndefined();
  });
});

describe('BudgetAutopilotService — autonomy lanes (spec D5/D6/D8)', () => {
  const PERF = [
    { channel: 'META', campaignRef: '', currentBudget: 100, spend: 100, revenue: 400 },
    { channel: 'GOOGLE', campaignRef: '', currentBudget: 100, spend: 100, revenue: 150 },
  ];
  const PERIOD = new Date().toISOString().slice(0, 7); // the CURRENT month
  const budget = (over: any = {}) => ({
    id: 'b1', workspaceId: 'ws1', status: 'ACTIVE', killSwitch: false,
    totalAmount: D(200), explorationPct: 0, targetRoas: null, periodKey: PERIOD,
    allocations: baseAllocs, autonomyLevel: 'ASSISTED', ...over,
  });

  afterEach(() => { delete process.env.GROWTH_AUTOPILOT_AUTONOMY; });

  it('SHADOW lane records the proposal but NEVER enqueues an approval', async () => {
    const d = makeDeps(budget({ autonomyLevel: 'SHADOW' }));
    d.perf.collect.mockResolvedValue(PERF);
    const r = await makeSvc(d).propose('ws1', 'b1');
    expect(r.status).toBe('PROPOSED');
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(r.approvalId).toBeUndefined();
    expect(d.executor.applyAutonomous).not.toHaveBeenCalled();
  });

  it('AUTONOMOUS + flag ON: bounds the pool by wallet credit and auto-applies with ZERO approvals', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const d = makeDeps(budget({ autonomyLevel: 'AUTONOMOUS' }));
    d.perf.collect.mockResolvedValue(PERF);
    d.wallet.balance.mockResolvedValue(D(30));
    d.wallet.governorDebited.mockResolvedValue(D(20));
    const r = await makeSvc(d).propose('ws1', 'b1');

    // D5 (audit B1): effective pool = min(cap 200, governorDebited 20 + balance 30)
    // = 50. The spent term is what the wallet ACTUALLY funded (clamped), so
    // governorDebited + balance == loaded-credit holds exactly — unlike raw
    // ledger netSpent, which keeps climbing past the funded envelope once the
    // wallet floors at 0 and would ratchet the ceiling toward the cap.
    expect(r.plan!.totalBudget).toBe(50);
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.executor.applyAutonomous).toHaveBeenCalledTimes(1);
    const [ws, b, after, runId] = d.executor.applyAutonomous.mock.calls[0];
    expect(ws).toBe('ws1');
    expect(b).toBe('b1');
    expect(Array.isArray(after) && after.length).toBeTruthy();
    expect(runId).toBe('run-1');
  });

  it('AUTONOMOUS honors the apply cooldown: a recent AUTO run means record-only', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const d = makeDeps(budget({ autonomyLevel: 'AUTONOMOUS' }));
    d.perf.collect.mockResolvedValue(PERF);
    d.wallet.balance.mockResolvedValue(D(1000));
    d.prisma.autopilotRun.findFirst.mockResolvedValue({ id: 'recent-auto' }); // inside cooldown
    const r = await makeSvc(d).propose('ws1', 'b1');
    expect(r.status).toBe('PROPOSED');
    expect(d.executor.applyAutonomous).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled(); // still no human gate in the autonomous lane
  });

  it('B1: an overspend past the funded credit can NOT ratchet the ceiling (wallet floored at 0)', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const d = makeDeps(budget({ autonomyLevel: 'AUTONOMOUS' }));
    d.perf.collect.mockResolvedValue(PERF);
    // Real ad spend ran to 200 but the wallet only ever funded 30 (loaded=30):
    d.wallet.balance.mockResolvedValue(D(0));
    d.wallet.governorDebited.mockResolvedValue(D(30));
    d.ledger.netSpent.mockResolvedValue(D(200)); // must be IGNORED
    const r = await makeSvc(d).propose('ws1', 'b1');

    expect(r.plan!.totalBudget).toBe(30); // pinned to loaded credit, not spend
  });

  it('B2: a STALE-period AUTONOMOUS budget never auto-applies (falls to the human gate)', async () => {
    process.env.GROWTH_AUTOPILOT_AUTONOMY = '1';
    const d = makeDeps(budget({ autonomyLevel: 'AUTONOMOUS', periodKey: '2020-01' }));
    d.perf.collect.mockResolvedValue(PERF);
    d.wallet.balance.mockResolvedValue(D(1000));
    const r = await makeSvc(d).propose('ws1', 'b1');

    expect(d.executor.applyAutonomous).not.toHaveBeenCalled();
    expect(d.wallet.balance).not.toHaveBeenCalled(); // stale lane never consults the wallet
    expect(d.enqueue).toHaveBeenCalledTimes(1); // human approval instead
    expect(r.approvalId).toBe('appr-1');
  });

  it('AUTONOMOUS with the flag OFF ships dark — behaves exactly like ASSISTED', async () => {
    const d = makeDeps(budget({ autonomyLevel: 'AUTONOMOUS' }));
    d.perf.collect.mockResolvedValue(PERF);
    const r = await makeSvc(d).propose('ws1', 'b1');
    expect(d.executor.applyAutonomous).not.toHaveBeenCalled();
    expect(d.enqueue).toHaveBeenCalledTimes(1); // falls back to the approval queue
    expect(r.approvalId).toBe('appr-1');
    // Flag off → wallet must NOT bound the pool (no behavior change while dark).
    expect(r.plan!.totalBudget).toBe(200);
  });
});
