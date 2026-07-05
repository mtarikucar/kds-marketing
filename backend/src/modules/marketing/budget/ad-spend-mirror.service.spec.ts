import { Prisma } from '@prisma/client';
import { AdSpendMirrorService } from './ad-spend-mirror.service';

const D = (n: number) => new Prisma.Decimal(n);
const NOW = new Date('2026-07-05T12:00:00.000Z');

/**
 * Ad-spend mirror (spec D3): engine-scoped AdMetric.spend is mirrored daily
 * into the SpendLedger (idempotent AD_SPEND entries) so the pacer sees REAL ad
 * spend, and — for armed AUTONOMOUS budgets — debited from the wallet as
 * clearly-labeled non-cash AD_GOVERNOR bookkeeping so credit truly governs.
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
  const ledger = { debitOnce: jest.fn().mockResolvedValue({ id: 'sl1', balanceAfter: D(0), replayed: false }) } as any;
  const wallet = { debitUpTo: jest.fn().mockResolvedValue({ wallet: {}, replayed: false, debited: D(0), shortfall: D(0) }) } as any;
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

  it('mirrors campaign-level AdMetric spend into ref-deduped AD_SPEND ledger entries + governor debits', async () => {
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
    expect(ledger.debitOnce).toHaveBeenCalledTimes(2);
    const first = ledger.debitOnce.mock.calls[0];
    expect(first[0]).toBe('ws1');
    expect(first[1]).toMatchObject({
      channel: 'META',
      reason: 'AD_SPEND',
      ref: 'admetric:c1:2026-07-04',
      budgetId: 'b1',
    });
    expect(first[1].amount.toString()).toBe('40');
    // Armed AUTONOMOUS → wallet governor bookkeeping under its own ref.
    expect(wallet.debitUpTo).toHaveBeenCalledTimes(2);
    expect(wallet.debitUpTo.mock.calls[0][1]).toMatchObject({
      kind: 'AD_GOVERNOR',
      ref: 'adgov:c1:2026-07-04',
    });
  });

  it('a replayed ledger ref does NOT double-debit the wallet governor', async () => {
    const { svc, ledger, wallet } = make({
      allocations: [{ channel: 'META', campaignRef: 'c1' }],
      metricsByCampaign: { c1: [{ campaignId: 'c1', date: new Date('2026-07-04T00:00:00.000Z'), spend: D(40) }] },
    });
    ledger.debitOnce.mockResolvedValue({ id: 'sl1', balanceAfter: D(-40), replayed: true });

    const r = await svc.mirrorForBudget('ws1', BUDGET, NOW);

    expect(r.mirrored).toBe(0); // nothing new
    expect(wallet.debitUpTo).not.toHaveBeenCalled();
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
    expect(ledger.debitOnce.mock.calls[0][1].ref).toBe('admetric:acct:acc-1:2026-07-05');
  });

  it('non-AUTONOMOUS budgets mirror the ledger (real pacing) but never touch the wallet', async () => {
    const { svc, ledger, wallet } = make({
      allocations: [{ channel: 'META', campaignRef: 'c1' }],
      metricsByCampaign: { c1: [{ campaignId: 'c1', date: new Date('2026-07-05T00:00:00.000Z'), spend: D(10) }] },
    });

    await svc.mirrorForBudget('ws1', { ...BUDGET, autonomyLevel: 'ASSISTED' }, NOW);

    expect(ledger.debitOnce).toHaveBeenCalledTimes(1);
    expect(wallet.debitUpTo).not.toHaveBeenCalled();
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
