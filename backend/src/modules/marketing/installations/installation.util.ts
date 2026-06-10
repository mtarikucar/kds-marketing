/**
 * Normalize a date input to a timezone-stable UTC-midnight Date that matches a
 * Postgres `@db.Date` column. InstallationJob.scheduledDate is date-only, but
 * the DTO (@IsDateString) accepts both '2026-06-15' and a full ISO timestamp
 * with an arbitrary offset. Without normalization, `new Date(...)` parses those
 * to different UTC calendar days, so the crew-capacity equality count and the
 * availability view can disagree about which day a job falls on (overbooking
 * gap). Canonicalizing to `<YYYY-MM-DD>T00:00:00.000Z` makes both use one key.
 */
export function toUtcDateOnly(input: string | Date): Date {
  const s = typeof input === "string" ? input : input.toISOString();
  const day = s.slice(0, 10); // YYYY-MM-DD
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${input}`);
  }
  return d;
}
