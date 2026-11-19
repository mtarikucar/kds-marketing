import { describe, expect, it } from 'vitest';
import { sparkBand, sparkY } from './AccountHeader';

/** Each known value's height in the 28-high line: 26 its bottom, 2 its top, 14 its middle. */
const heights = (values: (number | null)[]) => {
  const band = sparkBand(values);
  return band && values.map((v) => (v == null ? null : Math.round(sparkY(band, v) * 100) / 100));
};

describe('the sparkline’s band', () => {
  it('draws one follower on 69 as a small step in the middle, not a cliff', () => {
    const ys = heights([69, 69, 69, 70, 70, 70, 70, 69])!;
    const step = ys[0]! - ys[3]!;
    // A sixth of 70 is the band: one follower is about a twelfth of the 24 drawn.
    expect(step).toBeCloseTo(24 / (70 / 6), 1);
    expect(step).toBeLessThan(2.5);
    for (const y of ys) expect(Math.abs(y! - 14)).toBeLessThan(1.5);
  });

  it('draws a flat series as a flat line in the middle', () => {
    expect(heights([69, 69, 69])).toEqual([14, 14, 14]);
    expect(heights([0, 0, 0])).toEqual([14, 14, 14]);
  });

  it('skips the days with no number', () => {
    expect(sparkBand([null, 100, null, 200])).toEqual(sparkBand([100, 200]));
    expect(heights([null, 100, null, 200])).toEqual([null, 26, null, 2]);
    expect(sparkBand([null, null])).toBeNull();
    expect(sparkBand([])).toBeNull();
  });

  it('puts a single day in the middle', () => {
    expect(heights([1250])).toEqual([14]);
  });

  it('uses the whole height for a real move: from 0 to many, halving, a fifth more', () => {
    expect(heights([0, 500, 12000])).toEqual([26, 25, 2]);
    expect(heights([100, 75, 50])).toEqual([2, 14, 26]);
    expect(heights([100, 120])).toEqual([26, 2]);
  });
});
