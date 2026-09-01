/**
 * zeroFill.ts — turn a SPARSE day series into a dense one.
 *
 * Every aggregate endpoint in this product builds its `byDay` array from a Map
 * keyed on the days that actually had rows. A quiet Tuesday is therefore ABSENT,
 * not zero — and a chart drawn straight from that array spaces its points evenly
 * regardless, so three posts on the 1st, the 8th and the 30th render as three
 * evenly spread points and the month reads as steady activity. The line is not
 * merely imprecise there; it says the opposite of what happened.
 *
 * Filling is the caller's job rather than the server's on purpose: the server
 * returning explicit zeros for every empty day would make "we have no data for
 * this network" and "this network did nothing" identical on the wire, and the
 * insights read model needs to keep those apart (see `coverage`).
 */

/** Any row that names its day. */
export interface DayRow {
  date: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `YYYY-MM-DD` for a UTC instant — the key shape every backend day column uses.
 *
 * Returns `''` rather than throwing on something unparseable. `toISOString()`
 * raises a RangeError on an Invalid Date, and this sits on the render path of a
 * dashboard fed by a wire response; one malformed row is a gap in a line, not a
 * blank screen.
 */
export const utcDayKey = (at: Date | string): string => {
  const d = typeof at === 'string' ? new Date(at) : at;
  return Number.isNaN(d?.getTime?.() ?? NaN) ? '' : d.toISOString().slice(0, 10);
};

/**
 * Every UTC day from `from` to `to` inclusive, as `YYYY-MM-DD`.
 *
 * Both ends are read as instants and reduced to their UTC day, so passing the
 * ISO bounds a zoned window produced (see `todayBounds.ts`) is safe: the window
 * may start at 21:00Z, and the day it belongs to is what comes back.
 *
 * Iteration steps through `Date.UTC(y, m, d + 1)` rather than adding 86 400 000
 * to a timestamp; the two agree in UTC, and only the first stays correct if this
 * is ever ported to a zoned key.
 */
export function dayRange(from: string | Date, to: string | Date): string[] {
  const start = new Date(`${utcDayKey(from)}T00:00:00.000Z`);
  const end = new Date(`${utcDayKey(to)}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  // A guard, not a policy: the widest window any of these endpoints will serve is
  // 180 days, so a range past that means a caller computed its bounds wrong and
  // is about to allocate an array measured in years.
  const span = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  if (span > 400) return [];
  const out: string[] = [];
  for (let i = 0; i <= span; i++) {
    out.push(new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * `rows` densified across `[from, to]`, in ascending date order.
 *
 * A day with no row is materialised from `empty(date)`, so the caller decides
 * what "nothing happened" means for its own shape — usually every numeric field
 * at 0. Rows outside the window are dropped; a duplicated day keeps the LAST
 * occurrence, matching how the callers' Maps were built upstream.
 */
export function zeroFillDays<T extends DayRow>(
  rows: T[] | undefined,
  from: string | Date,
  to: string | Date,
  empty: (date: string) => T,
): T[] {
  const byDate = new Map<string, T>();
  for (const r of rows ?? []) {
    if (r?.date) byDate.set(r.date.slice(0, 10), r);
  }
  return dayRange(from, to).map((date) => byDate.get(date) ?? empty(date));
}

/**
 * The same fill for a numeric shape, without making every caller write an
 * `empty()` that lists its own fields twice. `keys` are zeroed; `date` is set.
 */
export function zeroFillNumeric<T extends DayRow, K extends string>(
  rows: T[] | undefined,
  from: string | Date,
  to: string | Date,
  keys: readonly K[],
): (T & Record<K, number>)[] {
  const blankFor = (date: string) => {
    const blank = { date } as Record<string, unknown>;
    for (const k of keys) blank[k] = 0;
    return blank as T & Record<K, number>;
  };

  return zeroFillDays(rows as (T & Record<K, number>)[] | undefined, from, to, blankFor).map(
    (row) => {
      // A row that IS present may still omit a field the chart plots (a network
      // that reports impressions but not reach). Left undefined it would break
      // the scale silently; zeroed here it is at least drawn, and `coverage` is
      // what tells the reader the difference between the two.
      const filled = { ...row } as Record<string, unknown>;
      for (const k of keys) if (typeof filled[k] !== 'number') filled[k] = 0;
      return filled as T & Record<K, number>;
    },
  );
}
