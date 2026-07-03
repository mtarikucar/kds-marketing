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
