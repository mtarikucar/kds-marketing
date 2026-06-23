import { Injectable, Logger } from '@nestjs/common';
import { promises as dns } from 'dns';
import { safeFetch } from '../../../common/util/safe-fetch';

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

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MX_TIMEOUT_MS = 2500;

// A small disposable / throwaway domain blocklist → RISKY (still deliverable,
// but low-value; surfaced, not suppressed). Not exhaustive — tier-2 (a real
// verification API) is needs-external and deferred.
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com',
]);

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
    const addr = (email ?? '').trim().toLowerCase();
    if (!addr) return 'UNKNOWN';
    if (addr.length > 254 || !EMAIL_RE.test(addr)) return 'INVALID';
    const domain = addr.split('@')[1];
    if (!domain) return 'INVALID';
    if (DISPOSABLE.has(domain)) return 'RISKY';

    let tier1: EmailVerifyStatus;
    try {
      const mx = await this.withTimeout(dns.resolveMx(domain), MX_TIMEOUT_MS);
      tier1 = Array.isArray(mx) && mx.length > 0 ? 'VALID' : 'INVALID';
    } catch (e: any) {
      // No such domain / no MX records = the address can't receive mail → INVALID.
      // A timeout or other transient DNS failure → UNKNOWN (don't penalize).
      tier1 = e?.code === 'ENOTFOUND' || e?.code === 'ENODATA' ? 'INVALID' : 'UNKNOWN';
    }
    // Tier-2 (real mailbox verification) — only when an operator wired a provider,
    // and only for addresses tier-1 didn't already rule out (saves paid lookups).
    if (tier1 !== 'INVALID' && isEmailVerifyTier2Configured()) {
      const refined = await this.verifyExternal(addr);
      if (refined) return refined;
    }
    return tier1;
  }

  /** POST {email} to the configured verification API; null on any failure (keep tier-1). */
  private async verifyExternal(email: string): Promise<EmailVerifyStatus | null> {
    try {
      const res = await safeFetch(process.env.EMAIL_VERIFY_API_URL!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.EMAIL_VERIFY_API_KEY}` },
        body: JSON.stringify({ email }),
        timeoutMs: 4000,
      } as any);
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { status?: string; result?: string } | null;
      return mapVerifyVerdict(body?.status ?? body?.result);
    } catch (e) {
      this.logger.warn(`tier-2 email verify failed: ${(e as Error)?.message}`);
      return null;
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    // Clear the timer the instant the race settles — otherwise a fast DNS win
    // leaves a 2.5s timer armed per create(), pinning the event loop (and
    // delaying graceful SIGTERM shutdown by up to the timeout). unref() is
    // belt-and-suspenders so a still-pending timer never holds the loop open.
    let timer: NodeJS.Timeout;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('mx-timeout')), ms);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}
