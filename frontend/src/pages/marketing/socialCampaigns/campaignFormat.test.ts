import { describe, it, expect } from 'vitest';
import { cadenceSummary, relativeFromNow } from './campaignFormat';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NOW = new Date('2026-07-10T12:00:00Z');

describe('cadenceSummary', () => {
  it('joins frequency, day names, and time', () => {
    expect(cadenceSummary({ perWeek: 3, daysOfWeek: [1, 3], timeOfDay: '09:00' }, DAYS)).toBe('3× · Mon, Wed · 09:00');
  });
  it('drops empty parts gracefully', () => {
    expect(cadenceSummary({ daysOfWeek: [], timeOfDay: '18:00' }, DAYS)).toBe('18:00');
    expect(cadenceSummary(null, DAYS)).toBe('');
  });
});

describe('relativeFromNow', () => {
  it('formats future hours and days', () => {
    expect(relativeFromNow(new Date(NOW.getTime() + 2 * 3600_000).toISOString(), NOW, 'en')).toMatch(/2 hours/);
    expect(relativeFromNow(new Date(NOW.getTime() + 3 * 86400_000).toISOString(), NOW, 'en')).toMatch(/3 days/);
  });
  it('formats past times', () => {
    expect(relativeFromNow(new Date(NOW.getTime() - 5 * 3600_000).toISOString(), NOW, 'en')).toMatch(/5 hours ago/);
  });
  it('near-now reads as "now" (0 minutes)', () => {
    expect(relativeFromNow(new Date(NOW.getTime() + 10_000).toISOString(), NOW, 'en')).toMatch(/now|this minute/i);
  });
});
