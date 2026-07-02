import { toUtcDateOnly, upcomingWindow } from './installation.util';

describe('installation.util', () => {
  describe('toUtcDateOnly', () => {
    it('canonicalizes any date input to UTC-midnight of its calendar day', () => {
      expect(toUtcDateOnly('2026-07-02').toISOString()).toBe('2026-07-02T00:00:00.000Z');
      expect(toUtcDateOnly('2026-07-02T18:30:00+03:00').toISOString()).toBe('2026-07-02T00:00:00.000Z');
    });
  });

  describe('upcomingWindow', () => {
    // The bug: bounding "upcoming" by `now` (a mid-day instant) excluded a job
    // scheduled for TODAY, stored at <today>T00:00:00.000Z (before `now`).
    it('includes a job scheduled for TODAY (start is today UTC-midnight, not now)', () => {
      const now = Date.parse('2026-07-02T09:00:00Z'); // mid-morning UTC
      const { start, end } = upcomingWindow(now, 'UTC');
      const todayDateOnly = Date.parse('2026-07-02T00:00:00.000Z');
      // A gte:start filter must admit today's stored date-only value.
      expect(start.getTime()).toBeLessThanOrEqual(todayDateOnly);
      expect(start.toISOString()).toBe('2026-07-02T00:00:00.000Z');
      expect(end.toISOString()).toBe('2026-07-09T00:00:00.000Z');
    });

    it('anchors to the WORKSPACE calendar day across the UTC/tz boundary', () => {
      // 2026-07-01T22:00Z is already 2026-07-02 01:00 in Istanbul (UTC+3): the
      // workspace's "today" is Jul 2, so a Jul 2 job must count as upcoming.
      const now = Date.parse('2026-07-01T22:00:00Z');
      const { start } = upcomingWindow(now, 'Asia/Istanbul');
      expect(start.toISOString()).toBe('2026-07-02T00:00:00.000Z');
    });

    it('rolls the +7 window over a month boundary', () => {
      const now = Date.parse('2026-07-28T09:00:00Z');
      const { end } = upcomingWindow(now, 'UTC');
      expect(end.toISOString()).toBe('2026-08-04T00:00:00.000Z');
    });
  });
});
