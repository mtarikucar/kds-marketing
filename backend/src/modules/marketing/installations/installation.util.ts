/**
 * Normalize a date input to a timezone-stable UTC-midnight Date that matches a
 * Postgres `@db.Date` column. InstallationJob.scheduledDate is date-only, but
 * the DTO (@IsDateString) accepts both '2026-06-15' and a full ISO timestamp
 * with an arbitrary offset. Without normalization, `new Date(...)` parses those
 * to different UTC calendar days, so the crew-capacity equality count and the
 * availability view can disagree about which day a job falls on (overbooking
 * gap). Canonicalizing to `<YYYY-MM-DD>T00:00:00.000Z` makes both use one key.
 */
import { zonedParts } from '../sites/timezone-slots';

export function toUtcDateOnly(input: string | Date): Date {
  const s = typeof input === "string" ? input : input.toISOString();
  const day = s.slice(0, 10); // YYYY-MM-DD
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${input}`);
  }
  return d;
}

/**
 * The half-open-ish date window for the installations dashboard's "upcoming
 * week", anchored to the WORKSPACE's current calendar day.
 *
 * `scheduledDate` is a date-only (`@db.Date`) column stored at UTC-midnight of
 * the picked calendar day (see {@link toUtcDateOnly}). The dashboard previously
 * lower-bounded "upcoming" by `now` (a mid-day instant), so a job scheduled for
 * TODAY — stored as `<today>T00:00:00.000Z` — sorted BEFORE `now` for the whole
 * day and vanished from the ops board until midnight. Bound instead by the
 * UTC-midnight of the workspace's today (matching the stored representation) so
 * today's jobs are always included; `end` is 7 calendar days out.
 */
export function upcomingWindow(nowMs: number, tz: string): { start: Date; end: Date } {
  const { y, mo, d } = zonedParts(nowMs, tz);
  return {
    // Date.UTC normalizes the +7 day rollover across month/year boundaries.
    start: new Date(Date.UTC(y, mo - 1, d)),
    end: new Date(Date.UTC(y, mo - 1, d + 7)),
  };
}
