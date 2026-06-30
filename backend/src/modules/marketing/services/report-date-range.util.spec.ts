import { rangeEndInclusive } from './report-date-range.util';

describe('rangeEndInclusive', () => {
  it('bumps a bare date to end-of-day UTC so the end day is included', () => {
    expect(rangeEndInclusive('2026-06-25').toISOString()).toBe('2026-06-25T23:59:59.999Z');
  });

  it('includes a lead created during the selected end day (the bug it fixes)', () => {
    const end = rangeEndInclusive('2026-06-25');
    const createdMidday = new Date('2026-06-25T10:00:00.000Z');
    expect(createdMidday <= end).toBe(true);
    // sanity: the old `new Date('2026-06-25')` would have excluded it
    expect(createdMidday <= new Date('2026-06-25')).toBe(false);
  });

  it('passes a full datetime through unchanged', () => {
    expect(rangeEndInclusive('2026-06-25T08:30:00.000Z').toISOString()).toBe('2026-06-25T08:30:00.000Z');
  });
});
