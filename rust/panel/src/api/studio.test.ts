import { describe, expect, it } from 'vitest';
import tr from '@/i18n/tr.json';
import en from '@/i18n/en.json';
import { BUDGET_MOVE_STATES, instant } from './studio';

describe('studio api', () => {
  it('instant_accepts_both: RFC 3339 text and the legacy time tuple name the same instant', () => {
    const text = instant('2026-10-27T09:30:15.25+03:00');
    // 2026-10-27 is day 300 of the year; +03:00 is three hours ahead of UTC.
    const tuple = instant([2026, 300, 9, 30, 15, 250_000_000, 3, 0, 0]);
    expect(text.toISOString()).toBe('2026-10-27T06:30:15.250Z');
    expect(tuple.toISOString()).toBe(text.toISOString());
    expect(instant('2026-10-27T06:30:15.25Z').getTime()).toBe(text.getTime());
  });

  it('every budget move state the server knows has a label', () => {
    for (const state of BUDGET_MOVE_STATES) {
      expect(tr.studio.budgetState[state]).toBeTruthy();
      expect(en.studio.budgetState[state]).toBeTruthy();
    }
  });
});
