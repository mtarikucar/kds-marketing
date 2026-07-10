import { Prisma } from '@prisma/client';
import { BudgetPerformanceSource } from './budget-performance.source';

const D = (n: number) => new Prisma.Decimal(n);

function makePrisma(metrics: any[]) {
  return { prisma: { adMetric: { findMany: jest.fn().mockResolvedValue(metrics) } } as any };
}

describe('BudgetPerformanceSource', () => {
  it('aggregates spend/revenue/leads per provider channel and maps to allocations', async () => {
    const { prisma } = makePrisma([
      { spend: D(60), revenue: D(240), leads: 3, adAccount: { provider: 'META' } },
      { spend: D(40), revenue: D(160), leads: 2, adAccount: { provider: 'META' } },
      { spend: D(50), revenue: D(75), leads: 1, adAccount: { provider: 'TIKTOK' } },
    ]);
    const src = new BudgetPerformanceSource(prisma);
    const perf = await src.collect('ws1', [
      { channel: 'META', campaignRef: '', plannedAmount: D(100) },
      { channel: 'TIKTOK', campaignRef: '', plannedAmount: D(80) },
      { channel: 'CONTENT', campaignRef: '', plannedAmount: D(20) }, // no ad metrics -> holds
    ]);

    const meta = perf.find((p) => p.channel === 'META')!;
    expect(meta).toMatchObject({ currentBudget: 100, spend: 100, revenue: 400, conversions: 5 });
    const tiktok = perf.find((p) => p.channel === 'TIKTOK')!;
    expect(tiktok).toMatchObject({ spend: 50, revenue: 75, conversions: 1 });
    const content = perf.find((p) => p.channel === 'CONTENT')!;
    expect(content).toMatchObject({ currentBudget: 20, spend: 0, revenue: 0 });
  });

  it('gives each campaign its OWN true ROAS (not the channel blend) for campaign allocations', async () => {
    // Two META campaigns: c1 is a winner (ROAS 4), c2 a loser (ROAS 0.5).
    const { prisma } = makePrisma([
      { spend: D(100), revenue: D(400), leads: 8, campaignId: 'c1', adAccount: { provider: 'META' } },
      { spend: D(100), revenue: D(50), leads: 1, campaignId: 'c2', adAccount: { provider: 'META' } },
    ]);
    const src = new BudgetPerformanceSource(prisma);
    const perf = await src.collect('ws1', [
      { channel: 'META', campaignRef: 'c1', plannedAmount: D(100) },
      { channel: 'META', campaignRef: 'c2', plannedAmount: D(100) },
      { channel: 'META', campaignRef: '', plannedAmount: D(200) }, // rollup → channel total
    ]);

    const c1 = perf.find((p) => p.campaignRef === 'c1')!;
    expect(c1).toMatchObject({ spend: 100, revenue: 400 }); // ROAS 4 — NOT the 2.25 channel blend
    const c2 = perf.find((p) => p.campaignRef === 'c2')!;
    expect(c2).toMatchObject({ spend: 100, revenue: 50 }); // ROAS 0.5 — differentiated from c1
    const rollup = perf.find((p) => p.campaignRef === '')!;
    expect(rollup).toMatchObject({ spend: 200, revenue: 450 }); // channel total preserved
  });

  it('a campaign with no metrics in the window reads 0 spend/revenue (per-campaign, not blended up)', async () => {
    const { prisma } = makePrisma([
      { spend: D(100), revenue: D(400), leads: 8, campaignId: 'c1', adAccount: { provider: 'META' } },
    ]);
    const src = new BudgetPerformanceSource(prisma);
    const perf = await src.collect('ws1', [{ channel: 'META', campaignRef: 'c-new', plannedAmount: D(50) }]);
    expect(perf[0]).toMatchObject({ campaignRef: 'c-new', spend: 0, revenue: 0 });
  });

  it('queries only the trailing window', async () => {
    const { prisma } = makePrisma([]);
    const src = new BudgetPerformanceSource(prisma);
    const now = new Date('2026-07-08T00:00:00Z');
    await src.collect('ws1', [], now);
    const where = prisma.adMetric.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe('ws1');
    expect(where.date.gte).toEqual(new Date('2026-07-01T00:00:00Z')); // now - 7d
  });
});
