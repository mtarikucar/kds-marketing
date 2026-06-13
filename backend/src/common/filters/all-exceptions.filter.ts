import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Global error envelope (Reliability / Observability / API consistency).
 *
 * Before this, error responses came straight from Nest's default handling — a
 * usable but bare `{ statusCode, message, error }`, and 500s leaked nothing
 * traceable. This filter makes every error response uniform and correlatable
 * WITHOUT breaking existing clients:
 *
 *   - It PRESERVES Nest's `statusCode` / `message` (the frontend reads
 *     `response.data.message`, and the ValidationPipe's array `message` is kept
 *     verbatim), then ADDS `requestId` (from the correlation middleware),
 *     `path`, and `timestamp`. Superset, not a reshape — so nothing downstream
 *     has to change.
 *   - Unknown (non-HTTP) errors become a clean 500 with the same envelope and
 *     are logged with their stack + the request id, so a support ticket quoting
 *     the id points straight at the log line. The raw error is never echoed to
 *     the client.
 *
 * Success-path envelopes (e.g. the `/api/internal/*` `{ resolved }` / `{ id }`
 * bodies) are untouched — those aren't exceptions.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    let body: Record<string, unknown>;
    if (isHttp) {
      const resp = exception.getResponse();
      body =
        typeof resp === 'string'
          ? { statusCode: status, message: resp }
          : { ...(resp as Record<string, unknown>) };
    } else {
      body = {
        statusCode: status,
        message: 'Internal server error',
        error: 'Internal Server Error',
      };
    }

    body.requestId = req.id ?? null;
    body.path = req.originalUrl ?? req.url;
    body.timestamp = new Date().toISOString();

    // 5xx is on us — log the cause with the correlation id. 4xx is client input
    // and already visible in access logs, so we don't spam error logs with it.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${req.id ?? '-'}] ${req.method} ${req.originalUrl ?? req.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(status).json(body);
  }
}
