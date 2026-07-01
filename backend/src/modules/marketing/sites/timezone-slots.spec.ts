import { zonedWallTimeToUtcMs, zonedParts, parseHm, formatInTimeZone } from './timezone-slots';

describe('timezone-slots', () => {
  it('converts an Istanbul wall time (UTC+3, no DST) to the right UTC instant', () => {
    // 2027-06-14 09:00 in Istanbul = 06:00 UTC
    const utc = zonedWallTimeToUtcMs(2027, 6, 14, 9, 0, 'Europe/Istanbul');
    expect(new Date(utc).toISOString()).toBe('2027-06-14T06:00:00.000Z');
  });

  it('is identity for UTC', () => {
    expect(new Date(zonedWallTimeToUtcMs(2027, 6, 14, 9, 0, 'UTC')).toISOString()).toBe('2027-06-14T09:00:00.000Z');
  });

  it('handles a DST timezone correctly across the transition (America/New_York)', () => {
    // Summer (EDT, UTC-4): 2027-07-01 09:00 NY = 13:00 UTC
    expect(new Date(zonedWallTimeToUtcMs(2027, 7, 1, 9, 0, 'America/New_York')).toISOString()).toBe('2027-07-01T13:00:00.000Z');
    // Winter (EST, UTC-5): 2027-01-15 09:00 NY = 14:00 UTC
    expect(new Date(zonedWallTimeToUtcMs(2027, 1, 15, 9, 0, 'America/New_York')).toISOString()).toBe('2027-01-15T14:00:00.000Z');
  });

  it('zonedParts gives the tz-local date + weekday', () => {
    // 2027-06-14T00:30:00Z is still 2027-06-14 03:30 in Istanbul (Monday)
    const p = zonedParts(Date.parse('2027-06-14T00:30:00Z'), 'Europe/Istanbul');
    expect(p).toMatchObject({ y: 2027, mo: 6, d: 14, weekday: 1 });
  });

  it('formatInTimeZone renders the wall-clock time in the tz, not UTC', () => {
    // A booking confirmation/reminder must show the appointment in the calendar's
    // timezone, not UTC. 2026-07-01T11:00:00Z is 14:00 in Istanbul (UTC+3).
    const s = formatInTimeZone(new Date('2026-07-01T11:00:00.000Z'), 'Europe/Istanbul');
    expect(s).toMatch(/14:00/); // Istanbul wall-clock hour
    expect(s).not.toMatch(/11:00/); // NOT the raw UTC hour
    expect(s).toMatch(/2026/);
  });

  it('formatInTimeZone falls back to a UTC string for a bad timezone (never throws)', () => {
    const s = formatInTimeZone(new Date('2026-07-01T11:00:00.000Z'), 'Not/AZone');
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });

  it('parseHm parses and rejects', () => {
    expect(parseHm('09:30')).toEqual([9, 30]);
    expect(parseHm('24:00')).toBeNull();
    expect(parseHm('nope')).toBeNull();
  });
});
