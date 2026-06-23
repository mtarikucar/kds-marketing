/**
 * Custom-domain white-label feature gate (GHL parity, Epic 13 — inert).
 *
 * Serving a tenant's own hostname needs wildcard ingress + on-demand TLS
 * (Caddy/ACME) that can only be provisioned by ops — so the Host-header
 * middleware is a pure no-op (passes every request straight through) until an
 * operator sets CUSTOM_DOMAINS_ENABLED. request() also refuses while disabled.
 */
export function isCustomDomainsEnabled(): boolean {
  return !!process.env.CUSTOM_DOMAINS_ENABLED;
}

/** The CNAME target tenants point their hostname at (the platform ingress). */
export function platformCnameTarget(): string {
  return process.env.CUSTOM_DOMAIN_CNAME_TARGET || 'ingress.platform.example';
}

/** Host→workspace resolution is cached this long to keep the middleware cheap. */
export const HOST_CACHE_TTL_MS = 30_000;
/** Hard cap on the host cache — Host headers are attacker-controllable and we
 *  negative-cache misses, so bound the Map (FIFO-evict) to prevent unbounded
 *  growth from sprayed garbage hosts. */
export const HOST_CACHE_MAX_ENTRIES = 5_000;
