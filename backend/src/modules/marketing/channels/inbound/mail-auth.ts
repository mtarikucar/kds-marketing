import { AuthVerdict, RawMail, headerLineValue } from './inbound-mail.types';

/**
 * Did the receiving server vouch for this sender?
 *
 * ## The bug
 *
 * Nothing read `Authentication-Results` at all, so a forged mail from
 * `patron@musteri.com.tr` (any `p=none` domain will do, which is most Turkish
 * SME domains) attached straight to the real customer's lead. The AI answered
 * it, workflows fired, follow-ups were cancelled, and bookings were made in the
 * customer's name (`inbound-unauthenticated`).
 *
 * ## Three states, and fail OPEN
 *
 * The obvious fix — "no auth pass, no ingest" — would be worse than the bug.
 * Most tenant mailboxes sit behind an MTA that writes no such header at all, so
 * a two-state verdict would mute every reply those mailboxes receive, and
 * silence is the exact failure mode this whole programme exists to remove.
 *
 * So: no header ⇒ `'unknown'` ⇒ **behaves exactly as today** — lead created,
 * fan-out fired, AI free to answer. Only an explicit `'fail'` downgrades, and
 * even then the mail is STILL ingested and STILL attached to the lead, with
 * `senderVerified: false` suppressing the AI reply, the `LeadCreated` fan-out
 * and tool use, and rendering a "Doğrulanmamış gönderici" badge.
 *
 * ## `'fail'` is narrow on purpose
 *
 * Only an explicit `dmarc=fail`, or `spf=fail` AND `dkim=fail` together.
 * Never `spf=softfail` alone, never `dkim=none` alone, never `spf=fail` alone:
 * forwarders and mailing-list relays legitimately produce each of those on
 * genuine customer mail, and treating them as forgeries would break real
 * replies. Several DKIM signatures count as a pass if ANY of them verified,
 * which is what a list relay's re-signature looks like.
 *
 * ## Only the first line is read
 *
 * A border MTA PREPENDS the result it vouches for, so the topmost
 * `Authentication-Results` line is the trusted one. Every line below it may
 * have been written by the sender. Reading through `headers.get()` — which
 * merges repeated headers into one value — is precisely how an injected
 * duplicate gets a vote, so this module reads the ordered RAW lines and takes
 * the first, via `headerLineValue`.
 */

/** The verdict plus what it was read from, for the badge and the ledger. */
export interface AuthAssessment {
  verdict: AuthVerdict;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  /** Where the answer came from: the trusted header, the ESP, or nowhere. */
  source: 'headers' | 'provider' | 'none';
}

/**
 * `spf=pass`, `dkim=fail`, `dmarc=none` — the method and its result, and
 * nothing else. `\b` before the method keeps `header.d=`, `smtp.mailfrom=` and
 * `header.i=` (which sit right beside the verdicts) out of the match.
 */
const METHOD_RE = /(?:^|[\s;])(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi;

/** Pass beats fail: one verified DKIM signature is a verified message. */
const RESULT_RANK: Record<string, number> = { pass: 3, fail: 2 };

export function assessAuth(mail: RawMail): AuthAssessment {
  // The FIRST line, never a merge of all of them. See the class doc.
  const line = headerLineValue(mail, 'authentication-results');
  if (line) {
    const read = readMethods(line);
    return { ...read, verdict: verdictOf(read), source: 'headers' };
  }

  // No border MTA wrote one — but on the webhook path the ESP *is* the MX and
  // posts its own verdict in its own field names. Without this, the one path
  // where spam is forwarded verbatim would be the one path with no check.
  const provider = mail?.providerAuth;
  if (provider && (provider.spf || provider.dkim || provider.dmarc)) {
    const read = {
      spf: normalizeResult(provider.spf),
      dkim: normalizeResult(provider.dkim),
      dmarc: normalizeResult(provider.dmarc),
    };
    return { ...read, verdict: verdictOf(read), source: 'provider' };
  }

  return { verdict: 'unknown', spf: null, dkim: null, dmarc: null, source: 'none' };
}

/** The three-state answer on its own, for the callers that want no detail. */
export function authVerdict(mail: RawMail): AuthVerdict {
  return assessAuth(mail).verdict;
}

function readMethods(line: string): Pick<AuthAssessment, 'spf' | 'dkim' | 'dmarc'> {
  const out: Record<string, string | null> = { spf: null, dkim: null, dmarc: null };
  METHOD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = METHOD_RE.exec(line)) !== null) {
    const method = m[1].toLowerCase();
    const result = m[2].toLowerCase();
    const current = out[method];
    // A message may carry several DKIM results; keep the strongest.
    if (!current || (RESULT_RANK[result] ?? 1) > (RESULT_RANK[current] ?? 1)) out[method] = result;
  }
  return { spf: out.spf, dkim: out.dkim, dmarc: out.dmarc };
}

/**
 * An ESP posts its verdict as a word (`Pass`), a phrase (`softfail`) or a
 * per-domain map (`{@acme.com : pass}`). Pull the result word out of whichever
 * of those arrived, preferring a pass when the map lists several.
 */
function normalizeResult(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (/\bsoftfail\b/.test(v)) return 'softfail';
  if (/\bpass\b/.test(v)) return 'pass';
  if (/\bfail\b/.test(v)) return 'fail';
  const other = /\b(none|neutral|temperror|permerror|policy)\b/.exec(v);
  return other ? other[1] : v;
}

function verdictOf(read: Pick<AuthAssessment, 'spf' | 'dkim' | 'dmarc'>): AuthVerdict {
  // DMARC is the only single signal strong enough to condemn a message: it is
  // the domain owner's own published policy about alignment.
  if (read.dmarc === 'fail') return 'fail';
  // Otherwise BOTH of the underlying methods have to have failed. Either one
  // alone is what an ordinary forward or list relay produces.
  if (read.spf === 'fail' && read.dkim === 'fail') return 'fail';
  if (read.dmarc === 'pass' || read.dkim === 'pass' || read.spf === 'pass') return 'pass';
  return 'unknown';
}
