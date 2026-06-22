import { describe, it, expect } from 'vitest';
import { toLocalYmd, toLocalHm, localDateTimeToIso } from './datetime';

describe('toLocalYmd', () => {
  it('returns the local calendar day, not a UTC-shifted one', () => {
    // Local midnight on 2026-06-22. In a UTC+ zone toISOString() would roll
    // this back to 2026-06-21 — toLocalYmd must NOT do that.
    const d = new Date(2026, 5, 22, 0, 0, 0); // month is 0-based: 5 = June
    expect(toLocalYmd(d)).toBe('2026-06-22');
  });

  it('zero-pads month and day', () => {
    const d = new Date(2026, 0, 5, 12, 0, 0); // 2026-01-05
    expect(toLocalYmd(d)).toBe('2026-01-05');
  });
});

describe('toLocalHm', () => {
  it('formats local hours and minutes zero-padded', () => {
    const d = new Date(2026, 5, 22, 9, 5, 0);
    expect(toLocalHm(d)).toBe('09:05');
  });
});

describe('localDateTimeToIso', () => {
  it('combines a local date + time into an ISO instant that reads back as that local wall-clock', () => {
    const iso = localDateTimeToIso('2026-06-22', '14:30');
    const back = new Date(iso);
    expect(back.getFullYear()).toBe(2026);
    expect(back.getMonth()).toBe(5);
    expect(back.getDate()).toBe(22);
    expect(back.getHours()).toBe(14);
    expect(back.getMinutes()).toBe(30);
  });

  it('defaults to 00:00 when no time is given', () => {
    const back = new Date(localDateTimeToIso('2026-06-22'));
    expect(back.getHours()).toBe(0);
    expect(back.getMinutes()).toBe(0);
  });

  it('returns empty string for an empty date', () => {
    expect(localDateTimeToIso('')).toBe('');
  });
});
