import { Injectable } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus metrics registry (Monitoring & Alerting) — backlog #2.
 *
 * Owns a DEDICATED `Registry` rather than prom-client's global default, so the
 * metric set is deterministic, isolated from any other library that might touch
 * the global, and safe to instantiate per app (the e2e harness boots several).
 *
 * Exposes two HTTP series populated by {@link MetricsInterceptor}:
 *   - `http_requests_total{method,route,status}` — request count / error rate.
 *   - `http_request_duration_seconds{method,route,status}` — latency histogram,
 *     enabling p50/p95/p99 and SLO burn-rate alerts.
 *
 * Default process metrics (CPU, memory, event-loop lag, GC) are collected too —
 * except under `NODE_ENV=test`, where the perf-hook timers they install would
 * otherwise keep Jest's event loop open.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpRequestsTotal: Counter<string>;
  readonly httpRequestDuration: Histogram<string>;

  constructor() {
    // Stamp every series with the replica id (container hostname) so counters
    // from different replicas behind one scrape target don't collide. Named
    // `replica` (not `instance`) to avoid clobbering Prometheus' own target
    // `instance` label. Opt-out/override via METRICS_REPLICA.
    const replica = process.env.METRICS_REPLICA ?? process.env.HOSTNAME;
    if (replica) {
      this.registry.setDefaultLabels({ replica });
    }

    if (process.env.NODE_ENV !== 'test') {
      collectDefaultMetrics({ register: this.registry });
    }

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests handled, labelled by method, matched route and status code.',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds, labelled by method, matched route and status code.',
      labelNames: ['method', 'route', 'status'],
      // Web-API oriented buckets: sub-10ms cache hits up to slow 5s tails.
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
  }

  /** Record one finished request. `route` is the matched pattern, not the raw URL (cardinality safety). */
  observe(method: string, route: string, status: number, seconds: number): void {
    const labels = { method, route, status: String(status) };
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDuration.observe(labels, seconds);
  }

  /** The Prometheus text exposition for the scrape endpoint. */
  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
