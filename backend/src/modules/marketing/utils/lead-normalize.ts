/**
 * Epic A4 — normalized lead match keys for duplicate detection.
 *
 * Phone: digits only (drops spaces, dashes, parens, leading +/00) so the same
 * number written different ways collides. Email: trimmed + lowercased.
 * Both return null for empty/blank input so absent contact info never matches.
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
