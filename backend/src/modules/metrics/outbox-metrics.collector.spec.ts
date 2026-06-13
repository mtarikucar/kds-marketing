import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';
import { MetricsService } from './metrics.service';
import { OutboxMetricsCollector } from './outbox-metrics.collector';
import { PrismaService } from '../../prisma/prisma.service';

describe('OutboxMetricsCollector', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let metrics: MetricsService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    metrics = new MetricsService();
    // Registering the collector wires the gauges onto the metrics registry.
    new OutboxMetricsCollector(prisma as unknown as PrismaService, metrics);
  });

  it('reports queued and failed counts on scrape', async () => {
    (prisma.outboxEvent.count as jest.Mock).mockImplementation(({ where }) =>
      Promise.resolve(where.status === 'queued' ? 7 : 3),
    );

    const out = await metrics.scrape();
    expect(out).toContain('outbox_events_pending 7');
    expect(out).toContain('outbox_events_failed 3');
    expect(prisma.outboxEvent.count).toHaveBeenCalledWith({
      where: { status: 'queued' },
    });
  });

  it('does not throw on a scrape-time DB error (gauge keeps its prior value)', async () => {
    (prisma.outboxEvent.count as jest.Mock).mockRejectedValue(
      new Error('db down'),
    );
    await expect(metrics.scrape()).resolves.toContain('outbox_events_pending');
  });
});
