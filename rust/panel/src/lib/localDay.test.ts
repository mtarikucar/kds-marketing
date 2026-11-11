import { describe, expect, it } from 'vitest';
import { dayRange, localMidnight, localToday } from './localDay';

describe('localDay', () => {
  it('local_midnight_in_three_zones', () => {
    expect(localMidnight('2026-11-01', 'Europe/Istanbul')).toBe('2026-10-31T21:00:00.000Z');
    expect(localMidnight('2026-11-01', 'UTC')).toBe('2026-11-01T00:00:00.000Z');
    // New York's clock goes back on 2026-11-01: that day starts on summer time, the next on winter time.
    expect(localMidnight('2026-11-01', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z');
    expect(localMidnight('2026-11-02', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z');
  });

  it('a_range_is_half_open_and_ends_at_the_next_local_midnight', () => {
    expect(dayRange('2026-11-01', '2026-11-30', 'Europe/Istanbul')).toEqual({
      from: '2026-10-31T21:00:00.000Z',
      to: '2026-11-30T21:00:00.000Z',
    });
  });

  it('today_is_the_zone_s_day', () => {
    const late = new Date('2026-11-04T22:30:00Z');
    expect(localToday('Europe/Istanbul', late)).toBe('2026-11-05');
    expect(localToday('America/New_York', late)).toBe('2026-11-04');
  });
});
