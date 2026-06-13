import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { OutboxMetricsCollector } from './outbox-metrics.collector';
import { BillingMetricsCollector } from './billing-metrics.collector';
import { MetricsAuthGuard } from './metrics-auth.guard';

/**
 * Monitoring surface (backlog #2): the `/api/metrics` scrape endpoint plus the
 * global interceptor that records request count + latency for every route, and
 * the business gauges (outbox pending / DLQ depth).
 *
 * The interceptor is registered as an APP_INTERCEPTOR here (not in
 * app.config.ts) so it ships with the module and is dependency-injected the
 * MetricsService — it runs in addition to the access-log interceptor.
 */
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricsAuthGuard,
    OutboxMetricsCollector,
    BillingMetricsCollector,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class MetricsModule {}
