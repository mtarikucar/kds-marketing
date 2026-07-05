import { Prisma } from '@prisma/client';
import { AdSpendMirrorService } from './ad-spend-mirror.service';

const D = (n: number) => new Prisma.Decimal(n);
const NOW = new Date('2026-07-05T12:00:00.000Z');

/**
 * Ad-spend mirror (spec D3): engine-scoped AdMetric.spend is mirrored into the
 * SpendLedger so the pacer sees REAL ad spend, and — for armed AUTONOMOUS
 * budgets — debited from the wallet as clearly-labeled non-cash AD_GOVERNOR
 * bookkeeping so credit truly governs.
 *
 * Audit B3+B4 contract: AdMetric.spend is a GROWING day-cumulative (overwritten
 * hourly), so both writes are delta-to-cumulative — the ledger appends only the
 * accrual above what it already mirrored, and the governor debit derives from
 * the WALLET's own ledger (never gated on the spend-ledger's replay flag), so a
 * crash between the two writes self-heals on the next tick.
 */
function make(over: {
  allocations?: any[];
  metricsByCampaign?: Record<string, any[]>;
  accounts?: any[];
  accountMetrics?: any[];
} = {}) {
  const prisma = {
    budgetAllocation: { findMany: jest.fn().mockResolvedValue(over.allocations ?? []) },
    adMetric: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.campaignId && where.campaignId !== '') {
          return over.metricsByCampaign?.[where.campaignId] ?? [];
        }
        return over.accountMetrics ?? [];
      }),
    },
    adAccount: { findMany: jest.fn().mockResolvedValue(over.accounts ?? []) },
  } as any;
  const ledger = {
    debitToCumulative: jest.fn().mockResolvedValue({
      id: 'sl1', balanceAfter: D(0), replayed: false, applied: D(1),
    }),
  } as any;
  const wallet = {
    debitUpToCumulative: jest.fn().mockResolvedValue({
      wallet: {}, replayed: false, debited: D(1), shortfall: D(0),
    }),
  } as any;
  const svc = new AdSpendMirrorService(prisma, ledger, wallet);
  return { prisma, ledger, wallet, svc };
}

const BUDGET = {
  id: 'b1', workspaceId: 'ws1', periodKey: '2026-07', status: 'ACTIVE',
  killSwitch: false, autonomyLevel: 'AUTONOMOUS',
} as any;

describe('AdSpendMirrorService', () => {
  beforeEach(() => { process.env.GROWTH_AUTOPILOT_AUTONOMY = '1'; });
  afterEach(() => { delete process.env.GROWTH_AUTOPILOT_AUTONOMY; });

  it('mirrors campaign-level day-cumulatives via delta-to-cumulative ledger + governor writes', async () => {
    const { svc, ledger, wallet } = make({
      allocations: [{ channel: 'META', campaignRef: 'c1' }],
      metricsByCampaign: {
        c1: [
          { campaignId: 'c1', date: new Date('2026-07-04T00:00:00.000Z'), spend: D(40) },
          { campaignId: 'c1', date: new Date('2026-07-05T00:00:00.000Z'), spend: D(25.5) },
        ],
      },
    });

    const r = await svc.mirrorForBudget('ws1', BUDGET, NOW);

    expect(r.mirrored).toBe(2);
    expect(ledger.debitToCumulative).toHaveBeenCalledTimes(2);
    const [ws, entry, refPrefix, cumulative] = ledger.debitToCumulative.mock.calls[0];
    expect(ws).toBe('ws1');
    expect(entry).toMatchObject({ channel: 'META', reason: 'AD_SPEND', budgetId: 'b1' });
    expect(refPrefix).toBe('admetric:c1:2026-07-04');
    expect(cumulative.toString()).toBe('40');
    // Armed AUTONOMOUS → governor tracks the same cumulative under its prefix.
    expect(wallet.debitUpToCumulative).toHaveBeenCalledTimes(2);
    const [gws, gmove, gprefix, gcum] = wallet.debitUpToCumulative.mock.calls[0];
    expect(gws).toBe('ws1');
    expect(gmove).toMatchObject({ kind: 'AD_GOVERNOR' });
    expect(gprefix).toBe('adgov:c1:2026-07-04');
    expect(gcum.toString()).toBe('40');
  });

  it('B3: a grown same-day cumulative mirrors the accrual (mirrored counts the fresh write)', async () => {
    const { svc, ledger } = make({
      allocations: [{ channel: 'META', campaignRef: 'c1' }],
      metricsByCampaign: { c1: [{ campaignId: 'c1', date: new Date('2026-07-05T00:00:00.000Z'), spend: D(200) }] },
    });
    ledger.debitToCumulative.mockResolvedValue({ id: 'sl2', balanceAfter: D(-200), replayed: false, applied: D(188) });

    const r = await svc.mirrorForBudget('ws1', BUDGET, NOW);

    expect(r.mirrored).toBe(1);
    expect(ledger.debitToCumulative.mock.calls[0][3].toString()).toBe('200'); // passes the CUMULATIVE, not a delta
  });

  it('an unchanged cumulative counts as nothing-new (applied 0 → not mirrored)', async () => {
    const { svc, ledger } = make({
      allocations: [{ channel: 'META', campaignRef: 'c1' }],
      metricsByCampaign: { c1: [{ campaignId: 'c1', date: new Date('2026-07-04T00:00:00.000Z'), spend: D(40) }] },
    });
    ledger.debitToCumulative.mockResolvedValue({ id: '', balanceAfter: D(-40), replayed: true, applied: D(0) });

    const r = await svc.mirrorForBudget('ws1', BUDGET, NOW);

    expect(r.mirrored).toBe(0);
  });

  it('B4: the governor write runs even when the ledger replays (crash self-heal, not replay-gated)', async () => {
    const { svc, ledger, wallet } = make({
      allocations: [{ channel: 'META', campaignRef: 'c1' }],
      metricsByCampaign: { c1: [{ campaignId: 'c1', date: new Date('2026-07-04T00:00:00.000Z'), spend: D(40) }] },
    });
    // Ledger already mirrored this cumulative (e.g. last tick crashed AFTER the
    // ledger commit but BEFORE the wallet debit)…
    ledger.debitToCumulative.mockResolvedValue({ id: '', balanceAfter: D(-40), replayed: true, applied: D(0) });
    wallet.debitUpToCumulative.mockResolvedValue({ wallet: {}, replayed: false, debited: D(40), shortfall: D(0) });

    const r = await svc.mirrorForBudget('ws1', BUDGET, NOW);

    // …the governor still catches up to the cumulative.
    expect(wallet.debitUpToCumulative).toHaveBeenCalledTimes(1);
    expect(r.governorDebits).toBe(1);
  });

  it('an already-caught-up governor is a replay (no double debit counted)', async () => {
    const { svc, wallet } = make({
      allocations: [{ channel: 'META', campaignRef: 'c1' }],
      metricsByCampaign: { c1: [{ campaignId: 'c1', date: new Date('2026-07-04T00:00:00.000Z'), spend: D(40) }] },
    });
    wallet.debitUpToCumulative.mockResolvedValue({ wallet: {}, replayed: true, debited: D(0), shortfall: D(0) });

    const r = await svc.mirrorForBudget('ws1', BUDGET, NOW);

    expect(r.governorDebits).toBe(0);
  });

  it('channel-level rollup ("" campaignRef) mirrors account-level rows of that channel provider', async () => {
    const { svc, prisma, ledger } = make({
      allocations: [{ channel: 'META', campaignRef: '' }],
      accounts: [{ id: 'acc-1', provider: 'META' }],
      accountMetrics: [{ campaignId: '', adAccountId: 'acc-1', date: new Date('2026-07-05T00:00:00.000Z'), spend: D(80) }],
    });

    const r = await svc.mirrorForBudget('ws1', BUDGET, NOW);

    expect(prisma.adAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: 'ws1', provider: 'META' }) }),
    );
    expect(r.mirrored).toBe(1);
    expect(ledger.debitToCumulative.mock.calls[0][2]).toBe('admetric:acct:acc-1:2026-07-05');
  });

  it('non-AUTONOMOUS budgets mirror the ledger (real pacing) but never touch the wallet', async () => {
    const { svc, ledger, wallet } = make({
      allocations: [{ channel: 'META', campaignRef: 'c1' }],
      metricsByCampaign: { c1: [{ campaignId: 'c1', date: new Date('2026-07-05T00:00:00.000Z'), spend: D(10) }] },
    });

    await svc.mirrorForBudget('ws1', { ...BUDGET, autonomyLevel: 'ASSISTED' }, NOW);

    expect(ledger.debitToCumulative).toHaveBeenCalledTimes(1);
    expect(wallet.debitUpToCumulative).not.toHaveBeenCalled();
  });

  it('only mirrors rows inside the budget month (periodKey window)', async () => {
    const { svc, prisma } = make({ allocations: [{ channel: 'META', campaignRef: 'c1' }], metricsByCampaign: { c1: [] } });
    await svc.mirrorForBudget('ws1', BUDGET, NOW);
    const where = prisma.adMetric.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe('ws1');
    expect(where.date.gte.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(where.spend).toEqual({ gt: 0 });
  });
});
