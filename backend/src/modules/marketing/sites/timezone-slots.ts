/**
 * Minimal, dependency-free IANA-timezone math for booking slots (audit C4).
 * Availability windows are wall-clock times in the calendar's timezone; these
 * helpers convert them to/from UTC instants (DST-safe via Intl), so a Turkey
 * (UTC+3) calendar's "09:00" window means 09:00 in Istanbul, not 09:00 UTC.
 */

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** ms to ADD to a UTC instant to get the wall-clock reading in `tz` at that instant. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) m[p.type] = p.value;
  const hour = m.hour === '24' ? 0 : +m.hour; // some engines emit 24 for midnight
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, hour, +m.minute, +m.second);
  return asUTC - utcMs;
}

/** A wall-clock time (y, mo[1–12], d, h, mi) in `tz` → its UTC epoch ms (DST-safe). */
export function zonedWallTimeToUtcMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(guess, tz);
  let real = guess - off1;
  const off2 = tzOffsetMs(real, tz);
  if (off2 !== off1) real = guess - off2; // correct across a DST transition
  return real;
}

/** The tz-local calendar date + weekday for a UTC instant. */
export function zonedParts(utcMs: number, tz: string): { y: number; mo: number; d: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
  const m: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) m[p.type] = p.value;
  return { y: +m.year, mo: +m.month, d: +m.day, weekday: WEEKDAY[m.weekday] ?? 0 };
}

/** Parse "HH:mm" → [hour, minute] or null. */
export function parseHm(s: string): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return [h, mi];
}
