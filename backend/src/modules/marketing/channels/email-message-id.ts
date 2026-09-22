/**
 * One spelling of a Message-ID.
 *
 * The same id arrives with angle brackets from an IMAP header, without them
 * from nodemailer's `info.messageId`, and with a mixed-case domain from
 * whichever server generated it. Threading (`no-threading-headers`),
 * Sent-folder dedupe and DSN attribution (`dsn-in-mailbox`) are all equality
 * checks, so all three have to be done on the same spelling — normalize BOTH
 * sides of every lookup, or the match simply never happens and nothing says so.
 *
 * `newMessageId` makes the id OURS and deterministic: the same ledger row
 * always produces the same id, which is what lets a resend be recognised
 * instead of filed as a new mail, and what lets a bounce report point at the
 * row it belongs to.
 */

/** Keep the local part short enough to leave the header well inside 998. */
const MAX_LOCAL_PART = 64;

const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/;

/**
 * Strip the angle brackets and lowercase the DOMAIN only — the local part is
 * case-sensitive per RFC 5322, and lowercasing it would break equality against
 * the server that issued it. Returns null for the empties so a missing id can
 * never be used as a lookup key that matches everything.
 */
export function normalizeMessageId(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  let v = raw.trim();
  if (!v) return null;
  // A header may carry a comment or a list beside the id; the first bracketed
  // value is the id itself.
  const bracketed = /<([^<>]*)>/.exec(v);
  if (bracketed) v = bracketed[1];
  v = v.replace(/[\s<>]/g, '');
  if (!v) return null;
  const at = v.lastIndexOf('@');
  // Some servers emit an id with no domain at all. It is still the only handle
  // on that mail, so it is kept rather than dropped.
  if (at <= 0) return v;
  return `${v.slice(0, at)}@${v.slice(at + 1).toLowerCase()}`;
}

/** Wrap for the wire, never twice. Null when there is nothing to wrap. */
export function toHeaderMessageId(id?: string | null): string | null {
  const v = normalizeMessageId(id);
  return v ? `<${v}>` : null;
}

/**
 * A deterministic Message-ID for one ledger row.
 *
 * `domainOrAddress` may be a bare domain or the From address the caller
 * already holds. Returns null when either half is unusable: the transport then
 * generates its own id, which is strictly better than emitting a header no
 * receiver will accept.
 */
export function newMessageId(seed?: string | null, domainOrAddress?: string | null): string | null {
  const local = localPart(seed);
  const domain = domainOf(domainOrAddress);
  return local && domain ? `${local}@${domain}` : null;
}

function localPart(seed?: string | null): string | null {
  if (typeof seed !== 'string') return null;
  const v = seed
    .trim()
    .toLowerCase()
    // Anything outside the safe set becomes a dash — a seed is an id, not
    // content, and a header is no place to find out it contained a CR.
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_LOCAL_PART)
    .replace(/^[-.]+|[-.]+$/g, '');
  return v.length ? v : null;
}

function domainOf(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  let d = value.trim().toLowerCase();
  const at = d.lastIndexOf('@');
  if (at >= 0) d = d.slice(at + 1);
  d = d.replace(/^[<\s]+/, '').replace(/[>\s.]+$/, '');
  return DOMAIN_RE.test(d) ? d : null;
}
