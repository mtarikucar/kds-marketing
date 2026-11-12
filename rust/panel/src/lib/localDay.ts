// Local days of a time zone as instants: a report's range is `[from, to)` in RFC 3339 instants,
// and the panel asks for whole days of the workspace's own zone (spec §3.16), whatever the
// browser's zone is. A clock change's day is 23 or 25 hours, as the server counts it.

/** `tz`'s offset from UTC, in milliseconds, at the instant `t`. */
function offsetAt(t: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - Math.floor(t / 1000) * 1000;
}

/** The instant the local day `date` (`YYYY-MM-DD`) begins in `tz`. */
export function localMidnight(date: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - offsetAt(wall, tz);
  // Once more at the found instant: the offset there is the day's own (a clock change near it).
  t = wall - offsetAt(t, tz);
  return new Date(t).toISOString();
}

/** The day after `date` (`YYYY-MM-DD`). */
export function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** `date` moved by `days` (`YYYY-MM-DD`). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today in `tz` (`YYYY-MM-DD`). */
export function localToday(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The days `first` to `last` (both included) of `tz` as the half-open range of instants. */
export function dayRange(first: string, last: string, tz: string): { from: string; to: string } {
  return { from: localMidnight(first, tz), to: localMidnight(nextDay(last), tz) };
}
