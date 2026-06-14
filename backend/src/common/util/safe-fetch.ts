import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF-hardened fetch. Reusable guard for any outbound call whose URL is
 * (even partly) caller-controlled — workflow http_webhook_out, future channel
 * webhooks, etc.
 *
 * Defenses:
 *  - scheme allow-list (http/https only — no file:, gopher:, data:, ...)
 *  - DNS-resolves the hostname and rejects loopback / private / link-local /
 *    reserved ranges (IPv4 + IPv6, incl. ::ffff: mapped + NAT64)
 *  - redirect: 'manual' — a 3xx is re-validated (the Location host is checked)
 *    rather than followed blindly (defeats DNS-rebind-via-redirect)
 *  - AbortController hard timeout
 *  - caps redirect hops
 *
 * NOTE: there is still a TOCTOU window between dns.lookup here and the kernel's
 * own resolution inside fetch(). For full DNS-rebinding immunity you must pin
 * the resolved IP into the connection (custom undici Agent/dispatcher with a
 * `connect.lookup`). This guard blocks the overwhelmingly common cases
 * (literal metadata IP, private hostnames, redirect-to-internal) and is the
 * pragmatic ceiling without swapping the HTTP stack. If you later add a pinned
 * dispatcher, plug it in at the marked spot.
 */

export interface SafeFetchOptions extends Omit<RequestInit, 'redirect'> {
  /** Hard timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Max 3xx hops to re-validate + follow (default 3). */
  maxRedirects?: number;
}

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** True if the literal IP string is loopback/private/link-local/reserved. */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIpv4(ip);
  if (fam === 6) return isBlockedIpv6(ip);
  return true; // not a parseable IP → refuse
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. 169.254.169.254 cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 (IETF / TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

function isBlockedIpv6(raw: string): boolean {
  const ip = raw.toLowerCase().split('%')[0]; // strip zone id
  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — validate the embedded v4
  const mapped = ip.match(/(?:::ffff:|::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  // NAT64 well-known prefix 64:ff9b::/96
  if (ip.startsWith('64:ff9b:')) return true;
  if (
    ip.startsWith('fe80') ||
    ip.startsWith('fe9') ||
    ip.startsWith('fea') ||
    ip.startsWith('feb')
  ) {
    return true; // fe80::/10 link-local
  }
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 unique-local
  if (ip.startsWith('ff')) return true; // ff00::/8 multicast
  if (ip.startsWith('2001:db8')) return true; // documentation
  return false;
}

/** Resolve a hostname and throw if ANY resolved address is internal. */
async function assertHostnameSafe(hostname: string): Promise<void> {
  // A bare IP literal in the URL: net.isIP catches it; check directly.
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare)) {
    if (isBlockedIp(bare)) {
      throw new SsrfBlockedError(`blocked IP literal: ${hostname}`);
    }
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw new SsrfBlockedError(`DNS resolution failed for ${hostname}`);
  }
  if (records.length === 0) {
    throw new SsrfBlockedError(`no DNS records for ${hostname}`);
  }
  for (const { address } of records) {
    if (isBlockedIp(address)) {
      throw new SsrfBlockedError(
        `${hostname} resolves to blocked address ${address}`,
      );
    }
  }
}

function assertUrlSafe(u: URL): void {
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    throw new SsrfBlockedError(`scheme not allowed: ${u.protocol}`);
  }
}

/**
 * SSRF-safe drop-in for fetch(). Resolves + validates the host before each
 * hop, follows 3xx manually (re-validating the redirect target), and aborts
 * on timeout. Throws SsrfBlockedError when a target is internal/disallowed.
 */
export async function safeFetch(
  rawUrl: string,
  init: SafeFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = 10_000, maxRedirects = 3, ...rest } = init;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`invalid URL: ${String(rawUrl).slice(0, 120)}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      assertUrlSafe(url);
      await assertHostnameSafe(url.hostname);

      const res = await fetch(url, {
        ...rest,
        redirect: 'manual',
        signal: controller.signal,
        // If you later add IP-pinning against DNS rebind, set the custom
        // dispatcher here (Node >=18 undici): `dispatcher: pinnedAgent(...)`.
      });

      // 3xx with a Location: re-validate the next hop instead of trusting fetch.
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        if (hop === maxRedirects) {
          throw new SsrfBlockedError('too many redirects');
        }
        const next = new URL(res.headers.get('location')!, url);
        // drain the redirect body so the socket can be reused
        await res.arrayBuffer().catch(() => undefined);
        url = next;
        continue;
      }
      return res;
    }
    throw new SsrfBlockedError('too many redirects');
  } finally {
    clearTimeout(timer);
  }
}
