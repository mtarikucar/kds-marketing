import { Injectable, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';
import { safeFetch } from '../../../common/util/safe-fetch';
import { isSingleAddress, normalizeAddress } from '../../../common/util/email-address';

export type EmailVerifyStatus = 'UNKNOWN' | 'VALID' | 'INVALID' | 'RISKY';

/** Tier-2 mailbox verification runs only when an operator wires a provider. */
export function isEmailVerifyTier2Configured(): boolean {
  return !!(process.env.EMAIL_VERIFY_API_URL && process.env.EMAIL_VERIFY_API_KEY);
}

/** Map a provider verdict onto our status. Covers ZeroBounce/NeverBounce/Kickbox vocab. */
export function mapVerifyVerdict(status: string | undefined): EmailVerifyStatus | null {
  const s = String(status ?? '').toLowerCase().replace(/[\s-]/g, '_');
  if (['valid', 'deliverable', 'ok'].includes(s)) return 'VALID';
  if (['invalid', 'undeliverable', 'do_not_mail', 'bounced'].includes(s)) return 'INVALID';
  if (['catch_all', 'accept_all', 'role', 'disposable', 'unknown', 'risky', 'spamtrap', 'abuse'].includes(s)) return 'RISKY';
  return null;
}

/**
 * The whole tier-1 DNS budget — the MX lookup AND the implicit-MX A/AAAA
 * fallback share it, so `verify()` (which sits on the create/edit request path)
 * can never cost more than this however the resolver behaves.
 */
const MX_TIMEOUT_MS = 2500;

/** The whole tier-2 provider call (lookup + request + body), when one is wired. */
const TIER2_TIMEOUT_MS = 4000;

/**
 * What one lookup told us. Only `nxdomain` and `nodata` are answers; `failed`
 * (timeout, SERVFAIL, refused, no resolver, anything else) means we learned
 * nothing about the domain and must never be read as "takes no mail".
 */
type DnsAnswer<T> =
  | { kind: 'records'; records: T[] }
  | { kind: 'nxdomain' }
  | { kind: 'nodata' }
  | { kind: 'failed' };

/** RFC 7505 null MX: `0 .` — c-ares hands the root target back as '' (or '.'). */
function isNullMx(r: { exchange?: unknown } | null | undefined): boolean {
  return !!r && (r.exchange === '' || r.exchange === '.');
}

function isUsableMx(r: { exchange?: unknown } | null | undefined): boolean {
  return !!r && typeof r.exchange === 'string' && r.exchange !== '' && r.exchange !== '.';
}

// A small disposable / throwaway domain blocklist → RISKY (still deliverable,
// but low-value; surfaced, not suppressed). Not exhaustive — tier-2 (a real
// verification API) is needs-external and deferred.
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com',
]);

/**
 * The verdict you can reach without touching the network.
 *
 * Every lead-creating path needs hygiene, but only some of them can pay for a
 * DNS round trip: `import.service.ts` creates its lead INSIDE a transaction and
 * `forms.service.ts` answers a visitor's POST, so a 2.5 s `resolveMx` there
 * would hold a pooled connection open per row (a 5k-row CSV becomes hours) or
 * stall the submit. Splitting the syntax half out lets those paths refuse the
 * garbage — which is what the bounces actually come from — and leave the
 * network verdict to `verify()` on the paths that can afford it.
 *
 * `UNKNOWN` for a well-formed address is deliberate and load-bearing: syntax
 * cannot prove deliverability, and `buildAudienceWhere` only excludes
 * `INVALID`, so claiming VALID here would smuggle unverified addresses past a
 * gate that is supposed to mean "MX-checked".
 */
export function classifyEmailSyntax(email: string | null | undefined): EmailVerifyStatus {
  const addr = normalizeAddress(email);
  if (!addr) return 'UNKNOWN';
  // `isSingleAddress` is the SAME rule the three send chokepoints enforce, so a
  // value stored here can never be one the transport would later refuse (or,
  // worse, expand into several deliveries).
  if (!isSingleAddress(addr)) return 'INVALID';
  const domain = addr.split('@')[1];
  if (!domain) return 'INVALID';
  if (DISPOSABLE.has(domain)) return 'RISKY';
  return 'UNKNOWN';
}

/**
 * List-hygiene tier-1 (GoHighLevel parity): classify an email by SYNTAX + MX so
 * an INVALID address never enters an email campaign audience. Best-effort and
 * non-blocking-safe — a transient DNS error is UNKNOWN (never suppress a
 * maybe-good lead on a network blip). Real-time mailbox verification (tier-2) is
 * a paid external API and is deferred.
 */
@Injectable()
export class EmailHygieneService {
  private readonly logger = new Logger(EmailHygieneService.name);

  async verify(email: string | null | undefined): Promise<EmailVerifyStatus> {
    const addr = normalizeAddress(email);
    if (!addr) return 'UNKNOWN';
    // The syntax half is shared with the write paths that cannot afford DNS, so
    // an address refused at import is refused here for the same reason.
    // RISKY (throwaway domain) short-circuits too: the domain answers mail, so
    // an MX lookup can only confirm what we already decided.
    const syntax = classifyEmailSyntax(addr);
    if (syntax !== 'UNKNOWN') return syntax;
    const domain = addr.split('@')[1];

    const tier1 = await this.dnsVerdict(domain);
    // Tier-2 (real mailbox verification) — only when an operator wired a provider,
    // and only for addresses tier-1 didn't already rule out (saves paid lookups).
    if (tier1 !== 'INVALID' && isEmailVerifyTier2Configured()) {
      const refined = await this.verifyExternal(addr);
      if (refined) return refined;
    }
    return tier1;
  }

  /**
   * Tier-1: does this domain route mail at all?
   *
   * INVALID suppresses the address on every send path, and SuppressionService
   * unions it across every lead sharing the address — so it is reserved for an
   * answer that PROVES the domain takes no mail:
   *
   * - NXDOMAIN (`ENOTFOUND`): the domain does not exist.
   * - A null MX (RFC 7505, `0 .`): the domain says it accepts no mail.
   * - The domain exists with no MX and definitively no A/AAAA either: the
   *   implicit MX of RFC 5321 §5.1 is unusable, which that section says MUST
   *   be reported as an error.
   *
   * No MX but an A/AAAA record is the RFC 5321 implicit MX — a mail route, so
   * VALID. Every lookup that failed to answer (timeout, SERVFAIL, refused, no
   * resolver, a malformed reply) is UNKNOWN, which every send path still mails.
   */
  private async dnsVerdict(domain: string): Promise<EmailVerifyStatus> {
    const deadline = Date.now() + MX_TIMEOUT_MS;
    const mx = await this.ask<{ exchange?: unknown }>(() => dns.resolveMx(domain), deadline);
    if (mx.kind === 'failed') return 'UNKNOWN';
    if (mx.kind === 'nxdomain') return 'INVALID';
    if (mx.kind === 'records') {
      if (mx.records.some(isUsableMx)) return 'VALID';
      // RFC 7505: a domain that publishes only `0 .` is stating it takes NO mail.
      if (mx.records.every(isNullMx)) return 'INVALID';
      // Records we cannot read are not the domain saying "no mail".
      return 'UNKNOWN';
    }
    // `nodata`: the domain exists and publishes no MX → RFC 5321 implicit MX.
    const [a, aaaa] = await Promise.all([
      this.ask(() => dns.resolve4(domain), deadline),
      this.ask(() => dns.resolve6(domain), deadline),
    ]);
    if (a.kind === 'records' || aaaa.kind === 'records') return 'VALID';
    if (a.kind === 'failed' || aaaa.kind === 'failed') return 'UNKNOWN';
    return 'INVALID';
  }

  /**
   * One lookup, bounded by the shared deadline, sorted into an answer or a
   * failure. Never rejects — including when the resolver throws synchronously.
   */
  private async ask<T>(query: () => Promise<T[]>, deadline: number): Promise<DnsAnswer<T>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { kind: 'failed' };
    try {
      const records = await this.withTimeout(query(), remaining, 'dns lookup');
      return Array.isArray(records) && records.length > 0 ? { kind: 'records', records } : { kind: 'nodata' };
    } catch (e: any) {
      // c-ares maps RCODE NXDOMAIN → ENOTFOUND and NOERROR-with-no-answer →
      // ENODATA. Those two are the resolver ANSWERING; every other code is it
      // failing to, and says nothing about the domain.
      if (e?.code === 'ENOTFOUND') return { kind: 'nxdomain' };
      if (e?.code === 'ENODATA') return { kind: 'nodata' };
      return { kind: 'failed' };
    }
  }

  /** POST {email} to the configured verification API; null on any failure (keep tier-1). */
  private async verifyExternal(email: string): Promise<EmailVerifyStatus | null> {
    // The cap wraps the WHOLE call: safeFetch's own `timeoutMs` only aborts the
    // fetch() — its SSRF hostname lookup runs before that timer and the body
    // read runs after it is cleared — and this sits on the lead create path.
    const ask = async (): Promise<EmailVerifyStatus | null> => {
      const res = await safeFetch(process.env.EMAIL_VERIFY_API_URL!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.EMAIL_VERIFY_API_KEY}` },
        body: JSON.stringify({ email }),
        timeoutMs: TIER2_TIMEOUT_MS,
      } as any);
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { status?: string; result?: string } | null;
      return mapVerifyVerdict(body?.status ?? body?.result);
    };
    try {
      return await this.withTimeout(ask(), TIER2_TIMEOUT_MS, 'tier-2 verify');
    } catch (e) {
      this.logger.warn(`tier-2 email verify failed: ${(e as Error)?.message}`);
      return null;
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label = 'hygiene'): Promise<T> {
    // Clear the timer the instant the race settles — otherwise a fast DNS win
    // leaves a 2.5s timer armed per create(), pinning the event loop (and
    // delaying graceful SIGTERM shutdown by up to the timeout). unref() is
    // belt-and-suspenders so a still-pending timer never holds the loop open.
    let timer: NodeJS.Timeout;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}
