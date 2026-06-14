import { Injectable, Logger } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from './metrics.service';
import { withTimeout } from '../../common/util/with-timeout';

// Cap each collect-time query so a hung DB can never wedge a /metrics scrape.
const COLLECT_TIMEOUT_MS = 1500;

/**
 * Business gauges for the durable outbox (Monitoring & Alerting) — extends the
 * backlog-#2 metrics surface beyond raw HTTP.
 *
 *   - `outbox_events_pending` — queued, not yet dispatched. A sustained climb
 *     means the worker isn't keeping up (or is wedged); alert on it.
 *   - `outbox_events_failed` — the DLQ depth. ANY non-zero value here is an
 *     operator-triage signal: events that exhausted their retries and will
 *     never deliver without intervention.
 *
 * Collected lazily on each Prometheus scrape via prom-client's `collect` hook,
 * so there's no background timer and the count is always fresh at read time. A
 * DB error during scrape is swallowed (the gauge keeps its prior value) so a
 * transient blip can't turn /metrics into a 500 and blind the scraper.
 */
@Injectable()
export class OutboxMetricsCollector {
  private readonly logger = new Logger(OutboxMetricsCollector.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {
    const collector = this;

    new Gauge({
      name: 'outbox_events_pending',
      help: 'OutboxEvent rows in status=queued awaiting dispatch.',
      registers: [this.metrics.registry],
      async collect() {
        await collector.setFromCount(this, 'queued');
      },
    });

    new Gauge({
      name: 'outbox_events_failed',
      help: 'OutboxEvent rows in status=failed (dead-letter queue; needs operator triage).',
      registers: [this.metrics.registry],
      async collect() {
        await collector.setFromCount(this, 'failed');
      },
    });

    new Gauge({
      name: 'outbox_events_dispatching',
      help: 'OutboxEvent rows in status=dispatching (claimed, in flight). A sustained climb means rows are being orphaned faster than the reclaim sweep recovers them.',
      registers: [this.metrics.registry],
      async collect() {
        await collector.setFromCount(this, 'dispatching');
      },
    });
  }

  private async setFromCount(gauge: Gauge<string>, status: string): Promise<void> {
    try {
      const n = await withTimeout(
        this.prisma.outboxEvent.count({ where: { status } }),
        COLLECT_TIMEOUT_MS,
        `outbox gauge (${status})`,
      );
      // The mocked-Prisma e2e seam returns undefined; only set a real number so
      // gauge.set never throws on a non-numeric value.
      if (typeof n === 'number') gauge.set(n);
    } catch (err) {
      // Timeout or DB error: keep the gauge's prior value, never hang or 500.
      this.logger.warn(
        `outbox gauge (${status}) scrape failed: ${(err as Error).message}`,
      );
    }
  }
}
