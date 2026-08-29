import { describe, it, expect, afterEach } from 'vitest';
import i18n from 'i18next';
import { fmtSlot, fmtDateTime } from './format';

// The module reads `i18n.language` on every call, so a test that changes it has
// to put it back or it leaks into whatever runs next in this file.
const originalLanguage = i18n.language;
afterEach(() => {
  i18n.language = originalLanguage;
});

// Local wall-clock, not an ISO instant: constructing from parts keeps the
// expected output independent of the machine's timezone.
const AUG_29_0905 = new Date(2026, 7, 29, 9, 5, 30);

describe('fmtSlot', () => {
  it('returns an empty string for a missing instant rather than "Invalid Date"', () => {
    expect(fmtSlot(null)).toBe('');
    expect(fmtSlot(undefined)).toBe('');
    expect(fmtSlot('')).toBe('');
  });

  // This is the whole reason fmtSlot exists next to fmtDateTime: a calendar is a
  // COLUMN of timestamps, so the year and the seconds are identical on every row
  // and only push the title off the line.
  it('drops the year and the seconds that fmtDateTime keeps', () => {
    expect(fmtDateTime(AUG_29_0905)).toContain('2026');
    expect(fmtSlot(AUG_29_0905)).not.toContain('2026');
    expect(fmtSlot(AUG_29_0905)).not.toContain('30');
    expect(fmtSlot(AUG_29_0905)).toContain('09:05');
  });

  it('names the month rather than numbering it, so 08/09 cannot be misread', () => {
    i18n.language = 'tr';
    expect(fmtSlot(AUG_29_0905)).toContain('Ağu');
  });

  // The point of living in this file: locale comes from i18next, NOT from the
  // OS default. A Turkish admin on an en-US machine was the original bug.
  it('follows the i18next language instead of the host default', () => {
    i18n.language = 'en';
    const en = fmtSlot(AUG_29_0905);
    i18n.language = 'tr';
    const tr = fmtSlot(AUG_29_0905);

    expect(en).toContain('Aug');
    expect(tr).toContain('Ağu');
    expect(en).not.toBe(tr);
  });

  it('falls back to Turkish when i18next has no language yet', () => {
    // i18next is not initialised in unit tests, so `language` is undefined here
    // — the same state as the first render before init resolves.
    i18n.language = undefined as unknown as string;
    expect(fmtSlot(AUG_29_0905)).toContain('Ağu');
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(fmtSlot(AUG_29_0905.toISOString())).toBe(fmtSlot(AUG_29_0905));
  });
});
