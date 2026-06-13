import { MetricsService } from './metrics.service';
import { BillingMetricsCollector } from './billing-metrics.collector';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * A minimal hand-rolled Prisma stub (rather than a deep mock): Prisma's
 * `groupBy` overload type is too complex to cast through `jest.Mock` without
 * tripping TS2615 (circular mapped type), and this collector only touches that
 * one method.
 */
describe('BillingMetricsCollector', () => {
  let groupBy: jest.Mock;
  let metrics: MetricsService;

  beforeEach(() => {
    groupBy = jest.fn();
    const prisma = { paymentOrder: { groupBy } } as unknown as PrismaService;
    metrics = new MetricsService();
    new BillingMetricsCollector(prisma, metrics);
  });

  it('emits one labelled sample per settlement status', async () => {
    groupBy.mockResolvedValue([
      { status: 'SUCCEEDED', _count: { _all: 12 } },
      { status: 'FAILED', _count: { _all: 2 } },
      { status: 'AWAITING_TRANSFER', _count: { _all: 5 } },
    ]);

    const out = await metrics.scrape();
    expect(out).toContain('payment_orders_total{status="SUCCEEDED"} 12');
    expect(out).toContain('payment_orders_total{status="FAILED"} 2');
    expect(out).toContain('payment_orders_total{status="AWAITING_TRANSFER"} 5');
  });

  it('clears stale labels between scrapes (a status that drops off disappears)', async () => {
    groupBy
      .mockResolvedValueOnce([{ status: 'FAILED', _count: { _all: 1 } }])
      .mockResolvedValueOnce([{ status: 'SUCCEEDED', _count: { _all: 3 } }]);

    await metrics.scrape();
    const second = await metrics.scrape();
    expect(second).toContain('payment_orders_total{status="SUCCEEDED"} 3');
    expect(second).not.toContain('status="FAILED"');
  });

  it('does not throw on a scrape-time DB error', async () => {
    groupBy.mockRejectedValue(new Error('db down'));
    await expect(metrics.scrape()).resolves.toContain('payment_orders_total');
  });
});
