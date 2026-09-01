import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  dayBoundsIso,
  todayBoundsIso,
  trailingDaysIso,
  zonedDayKey,
  resolveZone,
} from './todayBounds';

/**
 * Every assertion here names a zone EXPLICITLY, and none of them is the zone the
 * test runner happens to be in.
 *
 * That is deliberate and it is the point of the file. This repo's machines and
 * CI run in Europe/Istanbul, which is exactly the zone the bug being fixed here
 * hides in: code that quietly uses the browser's day boundary looks perfect on a
 * Turkish laptop and is three hours wrong for everyone else. Asserting in
 * Asia/Tokyo (+9, no DST), America/New_York (DST, negative offset) and UTC means
 * a regression to browser-local arithmetic fails here rather than in production.
 */
describe('todayBounds', () => {
  describe('dayBoundsIso', () => {
    it('brackets the zoned wall-clock day, not the UTC one', () => {
      // 2026-03-15T22:00Z is already 07:00 on the 16th in Tokyo (+9).
      const at = new Date('2026-03-15T22:00:00.000Z');
      expect(dayBoundsIso('Asia/Tokyo', at)).toEqual({
        from: '2026-03-15T15:00:00.000Z', // 2026-03-16 00:00 +09:00
        to: '2026-03-16T14:59:59.999Z', // 2026-03-16 23:59:59.999 +09:00
      });
    });

    it('gives the SAME instant a different day in two zones', () => {
      // The single moment 2026-03-15T22:00Z is the 16th in Tokyo and still the
      // 15th in New York — the whole reason the window may not be built from a
      // bare YYYY-MM-DD.
      const at = new Date('2026-03-15T22:00:00.000Z');
      expect(zonedDayKey('Asia/Tokyo', at)).toBe('2026-03-16');
      expect(zonedDayKey('America/New_York', at)).toBe('2026-03-15');
      expect(zonedDayKey('UTC', at)).toBe('2026-03-15');
    });

    /**
     * The bound the two servers can actually honour.
     *
     * Both of them filter `{ gte: from, lte: to }` — `SocialPlannerService.listPosts`
     * and `UnifiedCalendarService.range` alike — so "inside the window" means
     * `<= to`, and a `to` of the next day's midnight hands that midnight to TODAY
     * as well as to tomorrow. The post reads as the last item of one day and the
     * first of the next, on both screens, from one row.
     *
     * This is the assertion that pins the fix: under the old half-open value the
     * two instants below are equal, and equal is inside an `lte`.
     */
    it('ends before the next midnight, so an `lte` filter cannot hand it to two days', () => {
      const today = dayBoundsIso('Asia/Tokyo', new Date('2026-03-16T03:00:00.000Z'));
      const tomorrow = dayBoundsIso('Asia/Tokyo', new Date('2026-03-17T03:00:00.000Z'));
      const midnight = new Date(tomorrow.from).getTime();

      expect(midnight).toBeGreaterThan(new Date(today.to).getTime());
      // Adjacent to the millisecond: nothing falls between the two windows either.
      expect(new Date(today.to).getTime()).toBe(midnight - 1);
      expect(new Date(today.to).getTime()).toBeGreaterThan(new Date(today.from).getTime());
    });

    it('spans a whole day, inclusive of its last millisecond, in a zone with no DST', () => {
      const { from, to } = dayBoundsIso('Asia/Tokyo', new Date('2026-06-01T04:00:00.000Z'));
      expect(new Date(to).getTime() - new Date(from).getTime()).toBe(24 * 3600_000 - 1);
    });

    it('spans 23h on the spring-forward day and 25h on the fall-back day', () => {
      // US DST 2026: forward Sun 8 Mar, back Sun 1 Nov. The `- 1` is the
      // inclusive end, and it is the only thing DST does NOT change.
      const spring = dayBoundsIso('America/New_York', new Date('2026-03-08T12:00:00.000Z'));
      expect(new Date(spring.to).getTime() - new Date(spring.from).getTime()).toBe(
        23 * 3600_000 - 1,
      );

      const fall = dayBoundsIso('America/New_York', new Date('2026-11-01T12:00:00.000Z'));
      expect(new Date(fall.to).getTime() - new Date(fall.from).getTime()).toBe(25 * 3600_000 - 1);
    });

    it('starts the day at local midnight either side of a transition', () => {
      // 2026-03-08 00:00 EST = 05:00Z; the day ends a millisecond before
      // 2026-03-09 00:00 EDT = 04:00Z.
      const spring = dayBoundsIso('America/New_York', new Date('2026-03-08T12:00:00.000Z'));
      expect(spring.from).toBe('2026-03-08T05:00:00.000Z');
      expect(spring.to).toBe('2026-03-09T03:59:59.999Z');
    });

    it('resolves an instant that lands exactly on local midnight to that day', () => {
      const midnightTokyo = new Date('2026-03-15T15:00:00.000Z'); // 2026-03-16 00:00 +09
      expect(dayBoundsIso('Asia/Tokyo', midnightTokyo).from).toBe('2026-03-15T15:00:00.000Z');
      expect(zonedDayKey('Asia/Tokyo', midnightTokyo)).toBe('2026-03-16');
    });
  });

  describe('todayBoundsIso', () => {
    it('is dayBoundsIso for the given now', () => {
      const now = new Date('2026-08-31T21:30:00.000Z');
      expect(todayBoundsIso('Asia/Tokyo', now)).toEqual(dayBoundsIso('Asia/Tokyo', now));
    });
  });

  describe('trailingDaysIso', () => {
    it('includes today, so N days is today plus the N-1 before it', () => {
      const now = new Date('2026-08-31T02:00:00.000Z'); // 11:00 on the 31st in Tokyo
      const { from, to } = trailingDaysIso('Asia/Tokyo', 30, now);
      expect(zonedDayKey('Asia/Tokyo', new Date(from))).toBe('2026-08-02');
      expect(to).toBe(todayBoundsIso('Asia/Tokyo', now).to);
      // 30 whole days, less the millisecond the inclusive end gives up.
      expect(new Date(to).getTime() - new Date(from).getTime()).toBe(30 * 24 * 3600_000 - 1);
    });

    it('starts on a day boundary, not N*24h before now', () => {
      const now = new Date('2026-08-31T02:00:00.000Z');
      const { from } = trailingDaysIso('Asia/Tokyo', 7, now);
      expect(from).toBe(dayBoundsIso('Asia/Tokyo', new Date(from)).from);
    });

    it('still lands on whole days across a DST transition', () => {
      // A 7-day window ending 2026-03-10 in New York contains the spring-forward
      // day, so it is 7*24h - 1h of real time — but it must still START at local
      // midnight, which a fixed 6*24h subtraction alone would miss by an hour and
      // push into the previous day.
      const now = new Date('2026-03-10T16:00:00.000Z');
      const { from, to } = trailingDaysIso('America/New_York', 7, now);
      expect(zonedDayKey('America/New_York', new Date(from))).toBe('2026-03-04');
      expect(from).toBe(dayBoundsIso('America/New_York', new Date(from)).from);
      expect(new Date(to).getTime() - new Date(from).getTime()).toBe(
        7 * 24 * 3600_000 - 3600_000 - 1,
      );
    });

    it('handles a single-day window', () => {
      const now = new Date('2026-08-31T02:00:00.000Z');
      expect(trailingDaysIso('Asia/Tokyo', 1, now)).toEqual(todayBoundsIso('Asia/Tokyo', now));
    });
  });

  describe('resolveZone', () => {
    /**
     * Pin what the BROWSER reports, rather than inheriting the runner's own
     * zone. `resolveZone` is the one function here whose answer depends on the
     * machine, and the rule under test is specifically about what happens when
     * the browser and the stored workspace zone disagree — which cannot be
     * expressed at all if the browser's answer is whatever CI happens to be in.
     *
     * Stubbing `resolvedOptions` on the prototype touches ONLY the browser-zone
     * read: `isValidZone` merely constructs a formatter and the zoned maths
     * goes through `formatToParts`, so every other assertion in this file is
     * untouched by the stub.
     */
    function browserSays(zone: string) {
      vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
        timeZone: zone,
      } as Intl.ResolvedDateTimeFormatOptions);
    }
    afterEach(() => vi.restoreAllMocks());

    it('prefers the workspace zone over the browser it disagrees with', () => {
      browserSays('Europe/Istanbul');
      // The operator's laptop is not the business. A Tokyo workspace read from
      // an Istanbul desk still buckets its days in Tokyo.
      expect(resolveZone('Asia/Tokyo')).toBe('Asia/Tokyo');
      expect(resolveZone('America/New_York')).toBe('America/New_York');
    });

    it("treats a stored 'UTC' as 'nobody has said' and uses the browser instead", () => {
      // MIGRATION ACCOMMODATION, both directions pinned here so it cannot be
      // "simplified" away by someone who reads the column as an answer.
      //
      // `Workspace.timezone` defaulted to 'UTC' from the first migration and,
      // until registration started capturing a zone, had no writer a customer
      // could reach. So every existing row holds 'UTC' by omission and is
      // indistinguishable from a deliberate choice. Trusting it would give a
      // Turkish operator a 03:00→03:00 "today" — the exact off-by-the-offset
      // window this module was written to eliminate, re-introduced by the very
      // field that was added to fix it.
      browserSays('Europe/Istanbul');
      expect(resolveZone('UTC')).toBe('Europe/Istanbul');
    });

    it("keeps 'UTC' when the browser is on UTC too — the accommodation never invents a zone", () => {
      browserSays('UTC');
      expect(resolveZone('UTC')).toBe('UTC');
    });

    it('the accommodation is exactly one value wide: a non-UTC zone is never second-guessed', () => {
      // Deliberately a zone whose offset happens to be zero for part of the
      // year. It is still a PLACE, so it was chosen, so it wins.
      browserSays('Europe/Istanbul');
      expect(resolveZone('Europe/London')).toBe('Europe/London');
      expect(resolveZone('Etc/GMT')).toBe('Etc/GMT');
    });

    it('produces an Istanbul day, not a 03:00→03:00 one, for an un-migrated workspace', () => {
      // The consequence the rule exists for, asserted end-to-end rather than
      // left implicit in the string comparison above: a post scheduled at 01:00
      // Istanbul belongs to that Istanbul day and must be inside today's window.
      browserSays('Europe/Istanbul');
      const zone = resolveZone('UTC');
      const { from, to } = todayBoundsIso(zone, new Date('2026-08-31T12:00:00.000Z'));
      expect(from).toBe('2026-08-30T21:00:00.000Z'); // 2026-08-31 00:00 +03:00
      expect(to).toBe('2026-08-31T20:59:59.999Z'); // 2026-08-31 23:59:59.999 +03:00
      const earlyMorningPost = new Date('2026-08-30T22:00:00.000Z'); // 01:00 on the 31st
      expect(earlyMorningPost.getTime()).toBeGreaterThanOrEqual(new Date(from).getTime());
      expect(earlyMorningPost.getTime()).toBeLessThan(new Date(to).getTime());
    });

    it('falls back to a real zone when the workspace has none', () => {
      // Whatever the runner is in, it must be a zone Intl accepts — the point is
      // that the caller never receives undefined and never has to guess.
      const zone = resolveZone(undefined);
      expect(typeof zone).toBe('string');
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow();
    });

    it('falls back rather than trusting a garbage zone from the wire', () => {
      const zone = resolveZone('Not/AZone');
      expect(zone).not.toBe('Not/AZone');
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow();
    });
  });
});
