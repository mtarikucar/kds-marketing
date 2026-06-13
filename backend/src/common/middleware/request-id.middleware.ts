import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from '../logging/request-context';

/**
 * Correlation-id middleware (Observability / Auditability / Traceability).
 *
 * Every request gets a stable id that travels through the whole pipeline and
 * back out on the `X-Request-ID` response header (which main.ts already
 * advertises via CORS `exposedHeaders` — this is the producer that header was
 * always missing). An inbound `X-Request-ID` is honored so a caller (core, a
 * load balancer, the frontend) can thread one id across service hops; absent
 * or malformed, we mint a v4 uuid.
 *
 * The id is stashed on `req.id` / `req.requestId` so any logger or exception
 * filter downstream can attach it without re-parsing headers. Mounted first in
 * `configureApp`, so even bodies rejected by the parser carry an id.
 */
const HEADER = 'x-request-id';
// Accept only sane inbound ids (uuid-ish / opaque token) to avoid header
// injection or unbounded log keys; otherwise mint our own.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestIdMiddleware(
  req: Request & { id?: string; requestId?: string },
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.headers[HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id = candidate && SAFE_ID.test(candidate) ? candidate : randomUUID();

  req.id = id;
  req.requestId = id;
  res.setHeader('X-Request-ID', id);

  // Enter an AsyncLocalStorage scope for the rest of the request so any logger
  // downstream can stamp this id without it being passed around. Wrapping
  // `next()` keeps the store alive across every async hop that follows.
  runWithRequestContext({ requestId: id }, () => next());
}
