import { Prisma } from '@prisma/client';
import { BudgetAnomalyService } from './budget-anomaly.service';

const D = (n: number) => new Prisma.Decimal(n);
const NOW = new Date('2026-07-05T12:00:00.000Z');

/**
 * Anomaly auto-stop (spec D11): the machine stops ITSELF — never asks. Trips
 * pause the budget and record an ANOMALY_STOP run. Only armed AUTONOMOUS
 * budgets are evaluated (SHADOW/ASSISTED budgets never auto-spend, so pausing
 * them would be a behavior change for no protection).
 */
function make(over: {
  spent24h?: number;
  cap?: number | null;
  baseline?: { spend: number; revenue: number };
  today?: { spend: number; revenue: number };
  failedAutoRuns?: number;
} = {}) {
  const prisma = {
    spendLedger: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { delta: D(-(over.spent24h ?? 0)) } }),
    },
    pacingState: {
      findUnique: jest.fn().mockResolvedValue(
        over.cap === null ? null : { recommendedDailyCap: D(over.cap ?? 100) },
      ),
    },
    adMetric: {
      aggregate: jest
        .fn()
        // first call = trailing-7d baseline, second = current day
        .mockResolvedValueOnce({ _sum: { spend: D(over.baseline?.spend ?? 0), revenue: D(over.baseline?.revenue ?? 0) } })
        .mockResolvedValueOnce({ _sum: { spend: D(over.today?.spend ?? 0), revenue: D(over.today?.revenue ?? 0) } }),
    },
    autopilotRun: {
      count: jest.fn().mockResolvedValue(over.failedAutoRuns ?? 0),
      create: jest.fn().mockResolvedValue({ id: 'anom-run' }),
    },
    growthBudget: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  } as any;
  const svc = new BudgetAnomalyService(prisma);
  return { prisma, svc };
}

const BUDGET = { id: 'b1', workspaceId: 'ws1', status: 'ACTIVE', killSwitch: false, autonomyLevel: 'AUTONOMOUS' } as any;

describe('BudgetAnomalyService', () => {
  beforeEach(() => { process.env.GROWTH_AUTOPILOT_AUTONOMY = '1'; });
  afterEach(() => { delete process.env.GROWTH_AUTOPILOT_AUTONOMY; });

  it('trips on spend velocity (>3× daily cap in 24h): pauses the budget and records ANOMALY_STOP', async () => {
    const { svc, prisma } = make({ spent24h: 500, cap: 100 });
    const r = await svc.evaluate('ws1', BUDGET, NOW);

    expect(r.tripped).toBe(true);
    expect(r.reason).toContain('velocity');
    // Pause is workspace-scoped and instant.
    expect(prisma.growthBudget.updateMany).toHaveBeenCalledWith({
      where: { id: 'b1', workspaceId: 'ws1' },
      data: { status: 'PAUSED' },
    });
    const run = prisma.autopilotRun.create.mock.calls[0][0].data;
    expect(run).toMatchObject({ workspaceId: 'ws1', budgetId: 'b1', kind: 'ANOMALY_STOP', ok: false });
  });

  it('trips on ROAS collapse (today < 30% of 7d baseline while spending > 20% of cap)', async () => {
    const { svc } = make({
      spent24h: 50, cap: 100,
      baseline: { spend: 700, revenue: 2800 }, // baseline ROAS 4
      today: { spend: 30, revenue: 20 },       // today ROAS 0.67 < 1.2 (30% of 4), spend 30 > 20
    });
    const r = await svc.evaluate('ws1', BUDGET, NOW);
    expect(r.tripped).toBe(true);
    expect(r.reason).toContain('roas');
  });

  it('trips on repeated failed AUTO runs (≥5 in 24h)', async () => {
    const { svc } = make({ spent24h: 0, cap: 100, failedAutoRuns: 5 });
    const r = await svc.evaluate('ws1', BUDGET, NOW);
    expect(r.tripped).toBe(true);
    expect(r.reason).toContain('error');
  });

  it('does NOT trip under normal conditions', async () => {
    const { svc, prisma } = make({
      spent24h: 120, cap: 100,
      baseline: { spend: 700, revenue: 2800 },
      today: { spend: 50, revenue: 180 }, // ROAS 3.6 — healthy
      failedAutoRuns: 1,
    });
    const r = await svc.evaluate('ws1', BUDGET, NOW);
    expect(r.tripped).toBe(false);
    expect(prisma.growthBudget.updateMany).not.toHaveBeenCalled();
    expect(prisma.autopilotRun.create).not.toHaveBeenCalled();
  });

  it('skips non-AUTONOMOUS budgets entirely (no queries, no pause)', async () => {
    const { svc, prisma } = make({ spent24h: 9999, cap: 1 });
    const r = await svc.evaluate('ws1', { ...BUDGET, autonomyLevel: 'ASSISTED' }, NOW);
    expect(r.tripped).toBe(false);
    expect(prisma.spendLedger.aggregate).not.toHaveBeenCalled();
    expect(prisma.growthBudget.updateMany).not.toHaveBeenCalled();
  });

  it('a missing pacing cap disables the velocity rule but not the others', async () => {
    const { svc } = make({ spent24h: 9999, cap: null, failedAutoRuns: 0 });
    const r = await svc.evaluate('ws1', BUDGET, NOW);
    expect(r.tripped).toBe(false);
  });
});
