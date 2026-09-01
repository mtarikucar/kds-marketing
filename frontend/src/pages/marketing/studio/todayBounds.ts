/**
 * todayBounds.ts — "what counts as today" for the Growth Studio's publishing rail.
 *
 * Every date-filtered read in this product takes ABSOLUTE INSTANTS: the content
 * calendar controller parses whatever it is given with `new Date(raw)`, and
 * `SocialPost.scheduledAt` is a plain timestamp with no zone attached. So the
 * only question that matters is which two instants bracket the operator's day —
 * and the existing calendar gets that wrong in a way worth spelling out, because
 * this module exists to not repeat it.
 *
 * `ContentCalendarPage` builds its window as a bare `YYYY-MM-DD` string from the
 * browser's local `getFullYear/getMonth/getDate`. The backend then does
 * `new Date('2026-08-31')`, which JavaScript reads as UTC midnight. For a
 * Turkey (UTC+3) workspace, "today" therefore means 03:00 today → 03:00 tomorrow
 * in Istanbul: the 00:00–03:00 posts are missed and tomorrow's 00:00–03:00 are
 * wrongly included. The window is off by exactly the UTC offset, every day, on
 * every workspace that is not on UTC — and because the page then buckets the
 * rows it got back by browser-local day, its own grouping disagrees with the
 * window it asked for.
 *
 * The fix is not a smarter string. It is to stop sending dates and start sending
 * instants, computed in a zone we name out loud.
 */

/**
 * The instant at which `[zone]`'s wall-clock day containing `at` begins, and the
 * LAST instant of that same day — as ISO strings, an INCLUSIVE `[from, to]`.
 *
 * The inclusive end is not a taste question. It is what the servers on the other
 * end of these bounds actually do: `SocialPlannerService.listPosts` filters
 * `scheduledAt: { gte: from, lte: to }`, and `UnifiedCalendarService.range`
 * filters both of its tables the same way. This function used to return the
 * START of the following day and call the pair half-open, which the servers had
 * no way to honour — against an `lte`, a `to` of next midnight does not exclude
 * midnight, it INCLUDES it. A post scheduled at exactly 00:00 tomorrow therefore
 * came back at the bottom of today's rail, where it reads as the first thing of
 * the day, and came back again at the top of tomorrow's: one row, two days,
 * which is precisely the double-count the old comment promised could not happen.
 *
 * Ending at 23:59:59.999 makes the window mean, on the client, what the server
 * will do with it. The millisecond given up is not a reachable one — `DateTime`
 * columns store to the millisecond, so no instant exists between 23:59:59.999
 * and the next midnight for a post to fall into. {@link trailingUtcDays} has
 * always ended its window this way, for this reason; now the two agree.
 *
 * DST-safe by construction: rather than adding 24h to a start (which is wrong
 * twice a year, by an hour, in either direction), it resolves each boundary
 * independently through `Intl`.
 *
 * `zone` is expected to be the WORKSPACE's timezone (`WorkspaceProfile.timezone`).
 * Callers that cannot get one should pass the browser zone explicitly rather
 * than let this module guess — see {@link resolveZone}.
 */
export function dayBoundsIso(zone: string, at: Date = new Date()): { from: string; to: string } {
  const p = zonedParts(zone, at);
  // Both boundaries are resolved from a WALL-CLOCK date, never by adding hours to
  // an instant. `Date.UTC(y, mo-1, d + 1)` rolls the month and the year for us,
  // and zonedWallTimeToUtcMs then asks the zone what that midnight actually was —
  // which is what makes a 23- or 25-hour day come out right instead of being
  // assumed away.
  const dayAfter = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const nextMidnightMs = zonedWallTimeToUtcMs(
    zone,
    dayAfter.getUTCFullYear(),
    dayAfter.getUTCMonth() + 1,
    dayAfter.getUTCDate(),
  );
  return {
    from: new Date(zonedWallTimeToUtcMs(zone, p.year, p.month, p.day)).toISOString(),
    // The next day's midnight is still computed as a wall-clock boundary — the
    // subtraction happens only at the very end, so a 23- or 25-hour day still
    // ends when its own last hour does.
    to: new Date(nextMidnightMs - 1).toISOString(),
  };
}

/** Today's inclusive `[from, to]` in `zone`. The rail's window. */
export function todayBoundsIso(zone: string, now: Date = new Date()): { from: string; to: string } {
  return dayBoundsIso(zone, now);
}

/**
 * A trailing window of `days` whole zoned days ending at the END of today —
 * what the stats panel asks the metrics endpoints for. `days: 30` means the 30
 * calendar days up to and including today, not "720 hours ago until now", so
 * the first and last buckets are whole days like every bucket between them.
 *
 * The end is {@link dayBoundsIso}'s, so it is today's last instant and inclusive
 * like everything else here: `to - from` is `days * 24h - 1ms`, not `days * 24h`.
 */
export function trailingDaysIso(zone: string, days: number, now: Date = new Date()): { from: string; to: string } {
  const today = dayBoundsIso(zone, now);
  const p = zonedParts(zone, now);
  // (days - 1) because the window INCLUDES today: 30 days ending today is today
  // plus the 29 before it. The subtraction happens on the CALENDAR day number
  // and `Date.UTC` normalises the underflow across month and year ends, so no
  // instant arithmetic — and therefore no DST drift — is involved at all.
  const first = new Date(Date.UTC(p.year, p.month - 1, p.day - (days - 1)));
  const from = zonedWallTimeToUtcMs(
    zone,
    first.getUTCFullYear(),
    first.getUTCMonth() + 1,
    first.getUTCDate(),
  );
  return { from: new Date(from).toISOString(), to: today.to };
}

/**
 * A trailing window of `days` whole UTC days, ending with today's UTC day.
 *
 * Deliberately NOT zoned, and the difference is not an oversight.
 *
 * Two kinds of thing get windowed on this screen and they have different grain.
 * A scheduled post is an INSTANT, so "today" for the publishing queue is the
 * operator's own day and {@link trailingDaysIso} is right. A metric row is
 * stored against a `@db.Date` UTC day — the provider reported a number for a UTC
 * day and that is the only bucket it has. Asking for a zoned window over
 * UTC-day buckets does not make the buckets zoned; it just makes the window
 * straddle one extra bucket at each edge, so "30 gün" quietly draws 31 columns
 * and the two edge columns hold part of a day each.
 *
 * So metrics are asked for, bucketed and labelled in the grain they are actually
 * stored in. The cost is that an operator reading this at 01:00 in Istanbul sees
 * a window whose last bucket is the UTC day that began an hour ago; over a
 * 30-day trend that is not a distinction anyone can act on, and it is a far
 * smaller lie than a chart whose column count disagrees with its own label.
 */
export function trailingUtcDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const end = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return {
    from: start.toISOString(),
    // The last instant of today's UTC day, so the server's inclusive `lte`
    // filter keeps today's rows instead of stopping at midnight. Same convention
    // as {@link dayBoundsIso}, which is now stated in one place and held in
    // both: every `to` this module returns is a moment that is IN the window.
    to: new Date(end.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString(),
  };
}

/**
 * The `YYYY-MM-DD` key `at` falls on in `zone` — the bucket a row belongs to.
 *
 * Charts and the rail MUST group with this rather than with `getDate()`, or the
 * grouping silently disagrees with the window that fetched the rows, which is
 * precisely the inconsistency described at the top of this file.
 */
export function zonedDayKey(zone: string, at: Date | string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const p = zonedParts(zone, d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * The zone to compute in: the workspace's, or the browser's when the backend has
 * not told us (a rolling deploy serving the older profile shape), or UTC when
 * even `Intl` cannot say.
 *
 * The browser fallback is a genuine second-best, not a synonym: it at least
 * makes the window agree with the clock the operator is reading the screen by,
 * which the bare-`YYYY-MM-DD` code it replaces did not manage either.
 *
 * ── THE 'UTC' EXCEPTION IS A MIGRATION ACCOMMODATION. DELETE IT LATER. ───────
 *
 * A stored zone of exactly `'UTC'` is NOT treated as an instruction. It is
 * treated as "nobody has said", and the browser wins instead.
 *
 * That looks like the client second-guessing the server, so here is why it is
 * the honest rule rather than the convenient one. `Workspace.timezone` shipped
 * with the very first migration carrying a `'UTC'` default, and for its entire
 * life nothing on the self-serve path ever assigned it — the only writer in the
 * codebase was the agency createLocation call, which a customer never reaches.
 * So every workspace on the platform holds 'UTC' by omission, and the column
 * cannot distinguish that from a business that genuinely keeps its books in
 * UTC, because no code path has ever existed that could have written the latter
 * on purpose. Preferring the stored value unconditionally would therefore make
 * this module WORSE than the browser-only version it replaced: a Turkish
 * operator whose rail computed a correct Europe/Istanbul day would start
 * getting 03:00→03:00, which is precisely the off-by-the-UTC-offset window this
 * whole file exists to eliminate. Shipping the field would have quietly
 * re-introduced the bug it was added to fix.
 *
 * What the exception costs, stated plainly: a workspace that really does want
 * UTC, whose operator is sitting in another zone, gets that operator's zone
 * instead — wrong by at most one offset, in the same direction, for exactly the
 * case that the platform had no way to express until the column got its first
 * real writers. Every OTHER stored zone is honoured verbatim, including a
 * deliberate 'UTC' set from a browser that is also on UTC, so the rule never
 * fights an explicit choice it can actually recognise.
 *
 * This is temporary by construction. Registration now captures
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` (RegisterWorkspacePage →
 * RegisterWorkspaceDto.timezone), and PATCH /marketing/workspaces/timezone lets
 * an existing workspace be corrected. Once the column is populated everywhere —
 * a backfill, or simply enough time that no un-set row is still in use — 'UTC'
 * becomes a value someone chose, and this branch should be deleted so the
 * server's answer is final. Leave it in place until then; deleting it early
 * silently hands every un-migrated workspace the wrong day.
 */
export function resolveZone(workspaceTimezone?: string | null): string {
  const browser = browserZone();
  if (workspaceTimezone && isValidZone(workspaceTimezone)) {
    if (workspaceTimezone === 'UTC' && browser !== 'UTC') return browser;
    return workspaceTimezone;
  }
  return browser;
}

// ── internals ────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** `at` decomposed into `zone`'s wall-clock fields. */
function zonedParts(zone: string, at: Date): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const { type, value } of fmt.formatToParts(at)) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    // `hour12: false` still yields 24 for midnight in some engines. Normalising
    // it here means the arithmetic below never sees an hour that does not exist.
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Milliseconds to ADD to a UTC instant to get `zone`'s wall-clock reading of it. */
function zoneOffsetMs(zone: string, utcMs: number): number {
  const p = zonedParts(zone, new Date(utcMs));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

/**
 * A wall-clock date+time in `zone` → the UTC instant it names.
 *
 * This is the inverse of "what does this instant read as", and it needs two
 * passes rather than one: the offset we must subtract is the offset in force AT
 * THE ANSWER, which we do not have until we have the answer. Guess with the
 * offset at the naive instant, then re-ask at the result, and correct if the
 * transition moved under us.
 *
 * The naive alternative — take the instant and subtract its local time-of-day —
 * is what this deliberately is NOT. On a spring-forward day that overshoots into
 * the previous day, and a second pass then snaps to the START of that previous
 * day rather than correcting forward, so "today" silently becomes yesterday.
 * The backend already learned this for booking slots; `zonedWallTimeToUtcMs` in
 * backend/src/modules/marketing/sites/timezone-slots.ts is the same function,
 * and this is its client-side twin on purpose.
 */
function zonedWallTimeToUtcMs(zone: string, y: number, mo: number, d: number, h = 0, mi = 0): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = zoneOffsetMs(zone, naive);
  let real = naive - off1;
  const off2 = zoneOffsetMs(zone, real);
  if (off2 !== off1) real = naive - off2;
  return real;
}

/** The zone the browser reports, or 'UTC' if it will not say. Never throws and
 *  never returns undefined — callers of {@link resolveZone} must always get a
 *  zone `Intl` will accept, not a value they have to guard again. */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
