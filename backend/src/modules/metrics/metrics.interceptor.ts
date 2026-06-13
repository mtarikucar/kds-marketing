import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Feeds every finished HTTP request into the Prometheus histogram/counter.
 *
 * Labels use the MATCHED ROUTE PATTERN (`/api/marketing/leads/:id`), never the
 * raw URL — otherwise each distinct id would mint a new time series and blow up
 * cardinality. Requests that never matched a route (404s) collapse to a single
 * `unmatched` label for the same reason.
 *
 * The scrape endpoint and health probes are excluded: counting the monitoring
 * traffic itself only adds noise to the SLOs it's meant to measure.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const url = req.originalUrl ?? req.url;
    if (url.startsWith('/api/metrics') || url.startsWith('/api/health')) {
      return next.handle();
    }

    const start = process.hrtime.bigint();
    const record = () => {
      const route = this.routeLabel(req);
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.observe(req.method, route, res.statusCode, seconds);
    };

    return next.handle().pipe(tap({ next: record, error: record }));
  }

  private routeLabel(req: Request & { route?: { path?: string } }): string {
    // Express fills req.route (already including the global `api` prefix) only
    // when a handler matched; collapse everything else to a single label so an
    // attacker probing random paths can't explode time-series cardinality.
    return req.route?.path ?? 'unmatched';
  }
}
