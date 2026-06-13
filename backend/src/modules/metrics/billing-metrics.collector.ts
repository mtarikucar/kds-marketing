import { Injectable, Logger } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from './metrics.service';

/**
 * Settlement-outcome gauge (Monitoring & Alerting) — the last of the backlog-#2
 * business metrics ("request count/latency, outbox depth, settlement outcomes").
 *
 * `payment_orders_total{status}` exposes the current count of payment orders in
 * each settlement state (SUCCEEDED / FAILED / AWAITING_TRANSFER / …). It lets ops
 * alert on a rising FAILED rate or a growing manual-transfer backlog without
 * touching the production-critical settlement path — this is a pure read,
 * collected lazily per scrape, and the settlement service is unchanged.
 *
 * Labels reset each scrape so a status that drops to zero doesn't leave a stale
 * series. DB errors during scrape are swallowed (never 500 the scrape).
 */
@Injectable()
export class BillingMetricsCollector {
  private readonly logger = new Logger(BillingMetricsCollector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {
    const collector = this;

    new Gauge({
      name: 'payment_orders_total',
      help: 'Current count of payment orders by settlement status.',
      labelNames: ['status'],
      registers: [this.metrics.registry],
      async collect() {
        await collector.collectInto(this);
      },
    });
  }

  private async collectInto(gauge: Gauge<string>): Promise<void> {
    try {
      const grouped = await this.prisma.paymentOrder.groupBy({
        by: ['status'],
        _count: { _all: true },
      });
      // The mocked-Prisma e2e seam returns undefined; only act on a real array.
      if (!Array.isArray(grouped)) return;
      gauge.reset();
      for (const g of grouped) {
        gauge.set({ status: g.status }, g._count._all);
      }
    } catch (err) {
      this.logger.warn(
        `payment_orders gauge scrape failed: ${(err as Error).message}`,
      );
    }
  }
}
