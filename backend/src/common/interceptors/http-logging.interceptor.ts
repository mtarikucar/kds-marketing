import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { redactUrl } from '../util/redact-url';

/**
 * One structured access-log line per request, stamped with the correlation id
 * (Observability). Format: `[<requestId>] METHOD url status +durationms`, so a
 * support ticket quoting the X-Request-ID points straight at the request's
 * timing and outcome — and ties together with the exception filter's 5xx logs
 * that carry the same id.
 *
 * Health probes are skipped: they fire every few seconds and would drown the
 * log. Errors are logged at warn so failures stand out from the success stream.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request & { id?: string }>();
    const res = context.switchToHttp().getResponse<Response>();
    // Redact secret query params (e.g. the SSE `?access_token=`) — this line is
    // written to the access log on every request and must never carry a token.
    const url = redactUrl(req.originalUrl ?? req.url);

    if (url.startsWith('/api/health')) return next.handle();

    const start = Date.now();
    const line = () =>
      `[${req.id ?? '-'}] ${req.method} ${url} ${res.statusCode} +${Date.now() - start}ms`;

    return next.handle().pipe(
      tap({
        next: () => this.logger.log(line()),
        error: () => this.logger.warn(line()),
      }),
    );
  }
}
