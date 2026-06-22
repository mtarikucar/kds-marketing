/**
 * Timezone-correct local date/time helpers for the marketing forms.
 *
 * The bug these fix: `date.toISOString().split('T')[0]` on a local-midnight
 * Date in a UTC+ zone (Turkey is UTC+3) rolls the calendar day BACK one day.
 * These helpers read the LOCAL calendar fields instead, so the day the user
 * picked is the day that gets stored.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD` from a Date, using local calendar fields (no UTC shift). */
export function toLocalYmd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local `HH:mm` from a Date. */
export function toLocalHm(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Combine a local `YYYY-MM-DD` and optional `HH:mm` into a full ISO datetime
 * string. `new Date('2026-06-22T14:30')` (no zone suffix) is parsed by JS as
 * LOCAL wall-clock, so `.toISOString()` yields the correct UTC instant.
 * Returns '' for an empty/invalid date so callers can guard.
 */
export function localDateTimeToIso(ymd: string, hm?: string): string {
  if (!ymd) return '';
  const d = new Date(`${ymd}T${hm || '00:00'}`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
