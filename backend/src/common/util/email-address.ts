/**
 * One recipient, always — and no recipient may write a header.
 *
 * Every outbound path in this product takes a single `to` string and hands it
 * to a transport. Nothing ever checked that the string was ONE address, so
 * `info@x.com; satis@x.com` sent one mail (and one unsubscribe token) to two
 * people, and a `\r\n` in the value turned the recipient field into a header
 * writer — `email-oauth.sender.ts` builds RFC 822 by joining strings, so that
 * one is real injection rather than a theory (`single-recipient-check`,
 * `gmail-crlf-injection`).
 *
 * This lives in `common/` with no imports because the three chokepoints that
 * enforce it — the platform mailer, the channel adapter and the OAuth sender —
 * sit in three different trees, and three hand-written regexes is exactly how
 * they drift apart. `leads/email-hygiene.service.ts` and
 * `channels/conversation-ai-engine.service.ts` each keep a looser local copy;
 * they import this one and delete theirs.
 */

/** Longest address SMTP will carry (RFC 5321 §4.5.3.1.3). */
export const MAX_ADDRESS_LENGTH = 254;

/**
 * Exactly one bare address. The excluded characters are the whole point:
 * `\s` rejects CR/LF/tab (header injection and the line-folding trick),
 * `,` `;` reject the list forms, and `<` `>` `"` reject the display-name and
 * group forms that nodemailer would happily expand into several deliveries.
 * Plus-addressing and long TLDs still pass; a dotted domain is required because
 * every real customer address has one and `root@localhost` is not mail we send.
 */
export const SINGLE_ADDRESS_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;

/** CR, LF and NUL: the three bytes that end a header line (or a C string). */
const HEADER_BREAK_RE = /[\r\n\u0000]/;

export class HeaderInjectionError extends Error {
  constructor(field: string) {
    // The payload is never echoed: this message ends up in logs, and a log
    // line is a place an attacker would like their text to appear.
    super(`${field} contains a line break and cannot be used in a mail header`);
    this.name = 'HeaderInjectionError';
  }
}

/** Does this value carry something that would terminate a header line? */
export function hasHeaderInjection(value: string | null | undefined): boolean {
  return typeof value === 'string' && HEADER_BREAK_RE.test(value);
}

/**
 * Refuse to compose a header out of an injected value. Returns the value so it
 * can be asserted inline (`To: ${assertNoHeaderInjection(to, 'To')}`).
 *
 * This is the one place a throw is the right answer: the gateway uses the
 * predicate and returns a receipt (G2 — nothing new throws), but a MIME builder
 * has no receipt to return, and refusing to build the message IS the refusal.
 */
export function assertNoHeaderInjection(value: string, field = 'value'): string {
  if (hasHeaderInjection(value)) throw new HeaderInjectionError(field);
  return value;
}

/**
 * Is this exactly one deliverable address?
 *
 * Surrounding spaces are tolerated because every caller already trims before
 * sending, and refusing a padded address would refuse mail that goes out fine
 * today. CR/LF are NOT trimmed away — a trailing CRLF in a recipient field ends
 * the header block early and swallows the body, so it is refused outright.
 */
export function isSingleAddress(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  if (hasHeaderInjection(value)) return false;
  const v = value.trim();
  return v.length > 0 && v.length <= MAX_ADDRESS_LENGTH && SINGLE_ADDRESS_RE.test(v);
}

/**
 * The match key for an address: trimmed and lowercased, null when empty.
 *
 * Deliberately identical to `modules/marketing/utils/lead-normalize.ts`'s
 * `normalizeEmail`, because a suppression hash taken here has to match the
 * `emailNormalized` the lead was stored under — if the two rules ever differ,
 * an opt-out silently stops matching and the person keeps getting mail.
 * It normalizes without judging: validity is `isSingleAddress`'s question, and
 * a suppression row for a malformed address must still be matchable.
 */
export function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v.length ? v : null;
}
