/**
 * The three questions every priced-document mail and every accept path asks:
 * is this quote still good, how much is it, and by when.
 *
 * Pure, and shared on purpose. The expiry predicate used to be hand-rolled at
 * three call sites (`publicAccept`, `convertToInvoice`, and — missing entirely
 * — the send), which is how an expired quote could still be emailed: the
 * customer opened it, pressed Accept and was told "expired"
 * (`expired-quote-emailed`). The invariant is "never email something the
 * customer cannot accept", so the send and the accept have to share ONE
 * comparison, not two that drift.
 *
 * Money and dates live here for the same reason: `Invoice.total` and
 * `Estimate.total` are INTEGER MINOR units, and every extra `minor / 100` in
 * the codebase is another chance to bill ₺50 as "5000 TRY" in a customer's
 * inbox (`document-email-bare`).
 */

const DAY_MS = 86_400_000;

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Is a quote past its stated validity?
 *
 * INCLUSIVE end of day. `validUntil` is filled by an `<input type="date">`, so
 * "valid until 30 September" arrives as `2026-09-30T00:00:00Z`; a strict
 * `validUntil < now` would treat it as expired for the whole of the 30th — the
 * common "valid through Friday, sent Friday" case. The day the customer reads
 * on the page is a day they can still accept on.
 *
 * A null `validUntil` NEVER expires: `new Date(null)` is 1970, and a quote with
 * no stated expiry must not silently become unacceptable.
 */
export function isQuoteExpired(
  validUntil: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  const until = toDate(validUntil);
  if (!until) return false;
  const endOfDay = Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate()) + DAY_MS;
  return now.getTime() >= endOfDay;
}

/**
 * `125050` ⇒ `1.250,50 TRY` (tr) or `1,250.50 TRY`.
 *
 * Grouped by hand rather than through `toLocaleString`, because the node build
 * that renders this mail may carry small-icu and would then silently fall back
 * to English separators for a Turkish customer.
 */
export function formatMinorAmount(
  minor: number | null | undefined,
  currency: string | null | undefined,
  lang?: string | null,
): string {
  if (minor === null || minor === undefined) return '';
  const n = Number(minor);
  if (!Number.isFinite(n)) return '';

  const turkish = isTurkish(lang);
  const groupSep = turkish ? '.' : ',';
  const decimalSep = turkish ? ',' : '.';

  const negative = n < 0;
  const cents = Math.round(Math.abs(n));
  const major = Math.floor(cents / 100).toString();
  const fraction = (cents % 100).toString().padStart(2, '0');
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);

  return `${negative ? '-' : ''}${grouped}${decimalSep}${fraction} ${currency || 'TRY'}`;
}

/**
 * A due date a human reads: `30.09.2026` in Turkish, ISO everywhere else.
 *
 * Always in UTC. `dueDate`/`validUntil` are date-only values stored at UTC
 * midnight, so formatting them in the server's local zone moves "30 September"
 * to the 29th for any deployment west of Greenwich.
 */
export function formatDocumentDate(
  value: Date | string | null | undefined,
  lang?: string | null,
): string {
  const d = toDate(value);
  if (!d) return '';
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return isTurkish(lang) ? `${dd}.${mm}.${yyyy}` : `${yyyy}-${mm}-${dd}`;
}

/** `tr`, `TR`, `tr-TR` — the same normalisation `mail-copy` does. */
function isTurkish(lang?: string | null): boolean {
  return String(lang ?? '').trim().toLowerCase().split(/[-_]/)[0] === 'tr';
}
