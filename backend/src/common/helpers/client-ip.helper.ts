import { isIP } from "node:net";
import type { Request } from "express";

/**
 * Resolve the client IP for audit logging and rate-limit keying.
 *
 * We rely on Express's `req.ip`, which — with `trust proxy` configured (it is,
 * `app.set('trust proxy', 1)`) — already returns the real client IP honouring
 * the trusted-hop count. We do NOT fall back to the raw left-most
 * `X-Forwarded-For` value: that hop is client-supplied and fully spoofable, and
 * this value is persisted as audit attribution and used as a PSP fraud signal —
 * trusting raw XFF would let a caller forge it. If `req.ip` is somehow unset we
 * accept a forwarded value ONLY when it parses as a real IP, never arbitrary text.
 */
export function getClientIp(req: Request): string | undefined {
  if (req.ip) return req.ip;

  const xff = req.headers["x-forwarded-for"];
  if (!xff) return undefined;

  const raw = Array.isArray(xff) ? xff[0] : xff;
  const candidate = raw?.split(",")[0]?.trim();
  return candidate && isIP(candidate) ? candidate : undefined;
}
