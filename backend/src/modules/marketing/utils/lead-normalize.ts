/**
 * Epic A4 — normalized lead match keys for duplicate detection.
 *
 * Phone: digits only (drops spaces, dashes, parens, and the leading `+`) so the
 * same number written different ways collides. A leading `00` international-access
 * prefix is left INTACT here (it's digits) and reconciled by
 * `localMsisdnVariants`/`toIysMsisdn`. Email: trimmed + lowercased. Both return
 * null for empty/blank input so absent contact info never matches.
 */
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, '');
  return digits.length ? digits : null;
}

export function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const v = email.trim().toLowerCase();
  return v.length ? v : null;
}

/**
 * Given an already-digit-only value (see `normalizePhone`), enumerate every
 * `phoneNormalized` spelling a lead for that Turkish mobile number might
 * actually be stored under.
 *
 * `normalizePhone` is a pure digit-strip — it does NOT reconcile +90 vs
 * 0-prefixed vs bare-10-digit input. Every lead-creation path in this app
 * (forms, manual create, import, channel ingress) runs raw user/provider
 * input through `normalizePhone` alone, so the SAME real phone number ends up
 * with a DIFFERENT `phoneNormalized` value depending on which shape it
 * happened to arrive in: "05551112233" (0-prefixed, 11 digits), "5551112233"
 * (bare local, 10 digits), or "905551112233" (90-prefixed E.164 digits, 12 —
 * this is also the shape `NetgsmSmsAdapter.normalizeMsisdn` produces for
 * SMS-channel-ingressed leads, and the shape İYS's own `recipient` field
 * arrives in).
 *
 * Any code resolving an externally-sourced MSISDN (İYS push-back, a webhook,
 * ...) back to "the" lead for that number must search across ALL of these
 * spellings — an exact-match lookup keyed on just one silently misses leads
 * written via a different path. Returns the input unchanged (as the sole
 * candidate) when it doesn't reduce to a recognizable 10-digit Turkish
 * mobile shape, so a non-TR / malformed number still gets an exact-match
 * attempt instead of zero candidates.
 */
export function localMsisdnVariants(phoneNormalized: string): string[] {
  let d = phoneNormalized;
  // A leading `00` is the international-access prefix (00 + country code). Drop it
  // so `00·90·<local>` reduces exactly like `+90` / `0` / bare do — otherwise an
  // externally-sourced 00-form (import from a foreign CRM, some webhooks) would
  // fall through to the bare exact-match below and silently miss the same lead
  // stored via any other path. (normalizePhone keeps the 00; it only strips `+`.)
  if (d.length >= 12 && d.startsWith('00')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('90')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length !== 10) return [phoneNormalized];
  return [d, `0${d}`, `90${d}`];
}

/**
 * Normalize any Turkish mobile shape (+90XXXXXXXXXX, 0XXXXXXXXXX, bare
 * XXXXXXXXXX, with or without spaces/dashes) to İYS's own wire format:
 * `90` + the 10-digit local number, no `+` — the shape İYS's push-back
 * `recipient` field itself arrives in (see `localMsisdnVariants`'s
 * docstring) and the shape every İYS client fixture expects.
 *
 * Returns `null` when the input doesn't reduce to a recognizable 10-digit
 * Turkish MOBILE number (must start with `5` after the country/trunk prefix
 * is stripped) — a landline, a foreign number, or garbage input must never
 * be forwarded to İYS's `/iys/add` or `/iys/search` as if it were a valid
 * recipient; callers treat a `null` here as "can't verify" (fail closed),
 * never as "send it anyway".
 */
export function toIysMsisdn(raw: string | null | undefined): string | null {
  let d = (raw ?? '').replace(/\D/g, '');
  // Drop a leading `00` international-access prefix first (see localMsisdnVariants)
  // so a valid `00·90·<local>` mobile is recognised instead of failing closed —
  // an İYS-consented customer whose number arrives in 00-form must not be blocked
  // from commercial SMS. A non-TR number still fails the 10-digit/starts-with-5
  // guard below and returns null.
  if (d.length >= 12 && d.startsWith('00')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('90')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length !== 10 || !d.startsWith('5')) return null;
  return `90${d}`;
}
