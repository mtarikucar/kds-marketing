import { describe, it, expect } from 'vitest';
import { dayRange, utcDayKey, zeroFillDays, zeroFillNumeric } from './zeroFill';

describe('zeroFill', () => {
  describe('dayRange', () => {
    it('is inclusive at both ends', () => {
      expect(dayRange('2026-03-01', '2026-03-04')).toEqual([
        '2026-03-01',
        '2026-03-02',
        '2026-03-03',
        '2026-03-04',
      ]);
    });

    it('returns the single day for a same-day range', () => {
      expect(dayRange('2026-03-01', '2026-03-01')).toEqual(['2026-03-01']);
    });

    it('crosses a month and a year boundary', () => {
      expect(dayRange('2026-01-30', '2026-02-02')).toEqual([
        '2026-01-30',
        '2026-01-31',
        '2026-02-01',
        '2026-02-02',
      ]);
      expect(dayRange('2025-12-31', '2026-01-01')).toEqual(['2025-12-31', '2026-01-01']);
    });

    it('covers a leap day', () => {
      expect(dayRange('2028-02-28', '2028-03-01')).toEqual([
        '2028-02-28',
        '2028-02-29',
        '2028-03-01',
      ]);
    });

    it('does not lose or gain a day across a DST transition', () => {
      // The keys are UTC days, so a zone's clock change must not shorten the
      // range — the whole reason the loop steps in UTC rather than local time.
      expect(dayRange('2026-03-07', '2026-03-10')).toHaveLength(4);
      expect(dayRange('2026-10-31', '2026-11-02')).toEqual([
        '2026-10-31',
        '2026-11-01',
        '2026-11-02',
      ]);
    });

    it('accepts the ISO instants a zoned window produces', () => {
      // todayBoundsIso for Asia/Tokyo yields a `from` at 15:00Z the day BEFORE
      // the local day it names; reducing to the UTC day is what the stored
      // `@db.Date` column keys on, so that is the key the fill must use.
      expect(dayRange('2026-03-15T15:00:00.000Z', '2026-03-17T15:00:00.000Z')).toEqual([
        '2026-03-15',
        '2026-03-16',
        '2026-03-17',
      ]);
    });

    it('returns nothing for a reversed or unparseable range', () => {
      expect(dayRange('2026-03-04', '2026-03-01')).toEqual([]);
      expect(dayRange('not-a-date', '2026-03-01')).toEqual([]);
    });

    it('refuses an absurd range rather than allocating years of days', () => {
      expect(dayRange('2020-01-01', '2026-01-01')).toEqual([]);
    });
  });

  describe('utcDayKey', () => {
    it('reduces an instant to its UTC day', () => {
      expect(utcDayKey('2026-03-15T22:30:00.000Z')).toBe('2026-03-15');
      expect(utcDayKey(new Date('2026-03-15T00:00:00.000Z'))).toBe('2026-03-15');
    });
  });

  describe('zeroFillDays', () => {
    it('materialises the missing days in order', () => {
      const rows = [
        { date: '2026-03-01', n: 3 },
        { date: '2026-03-04', n: 7 },
      ];
      expect(zeroFillDays(rows, '2026-03-01', '2026-03-04', (date) => ({ date, n: 0 }))).toEqual([
        { date: '2026-03-01', n: 3 },
        { date: '2026-03-02', n: 0 },
        { date: '2026-03-03', n: 0 },
        { date: '2026-03-04', n: 7 },
      ]);
    });

    it('turns a three-point month into a real month', () => {
      // The failure this whole module exists for: without filling, these three
      // rows plot as three evenly spaced points and a sparse month reads busy.
      const rows = [
        { date: '2026-03-01', n: 1 },
        { date: '2026-03-08', n: 1 },
        { date: '2026-03-30', n: 1 },
      ];
      const filled = zeroFillDays(rows, '2026-03-01', '2026-03-31', (date) => ({ date, n: 0 }));
      expect(filled).toHaveLength(31);
      expect(filled.filter((r) => r.n > 0)).toHaveLength(3);
      expect(filled[1]).toEqual({ date: '2026-03-02', n: 0 });
    });

    it('drops rows outside the window', () => {
      const rows = [
        { date: '2026-02-27', n: 9 },
        { date: '2026-03-02', n: 4 },
      ];
      const filled = zeroFillDays(rows, '2026-03-01', '2026-03-02', (date) => ({ date, n: 0 }));
      expect(filled).toEqual([
        { date: '2026-03-01', n: 0 },
        { date: '2026-03-02', n: 4 },
      ]);
    });

    it('handles an empty or absent series', () => {
      expect(zeroFillDays([], '2026-03-01', '2026-03-02', (date) => ({ date, n: 0 }))).toEqual([
        { date: '2026-03-01', n: 0 },
        { date: '2026-03-02', n: 0 },
      ]);
      expect(zeroFillDays(undefined, '2026-03-01', '2026-03-01', (date) => ({ date, n: 0 }))).toEqual(
        [{ date: '2026-03-01', n: 0 }],
      );
    });

    it('normalises a full-instant date on an incoming row', () => {
      const rows = [{ date: '2026-03-02T00:00:00.000Z', n: 5 }];
      const filled = zeroFillDays(rows, '2026-03-01', '2026-03-02', (date) => ({ date, n: 0 }));
      expect(filled[1].n).toBe(5);
    });
  });

  describe('zeroFillNumeric', () => {
    it('zeroes every requested key on a missing day', () => {
      const rows = [{ date: '2026-03-02', reach: 10, impressions: 40 }];
      expect(
        zeroFillNumeric(rows, '2026-03-01', '2026-03-03', ['reach', 'impressions'] as const),
      ).toEqual([
        { date: '2026-03-01', reach: 0, impressions: 0 },
        { date: '2026-03-02', reach: 10, impressions: 40 },
        { date: '2026-03-03', reach: 0, impressions: 0 },
      ]);
    });

    it('zeroes a key a PRESENT row happens to omit', () => {
      // A network that reports impressions but never reach would otherwise leave
      // the scale reading undefined for that day and drop the point silently.
      const rows = [{ date: '2026-03-01', impressions: 12 }];
      expect(zeroFillNumeric(rows, '2026-03-01', '2026-03-01', ['reach', 'impressions'] as const)).toEqual(
        [{ date: '2026-03-01', reach: 0, impressions: 12 }],
      );
    });
  });
});
