import { safePage, safeLimit } from './paging';

describe('safePage', () => {
  it('passes a valid page through', () => expect(safePage(3)).toBe(3));
  it('coerces a numeric string', () => expect(safePage('4')).toBe(4));
  it('floors a fractional page', () => expect(safePage(2.9)).toBe(2));
  it('defaults NaN / non-numeric to 1', () => {
    expect(safePage(Number.NaN)).toBe(1);
    expect(safePage('abc')).toBe(1);
  });
  it('defaults undefined / null / 0 / negative to 1', () => {
    expect(safePage(undefined)).toBe(1);
    expect(safePage(null)).toBe(1);
    expect(safePage(0)).toBe(1);
    expect(safePage(-5)).toBe(1);
  });
});

describe('safeLimit', () => {
  it('passes a value within range through', () => expect(safeLimit(20, 50, 200)).toBe(20));
  it('caps at max', () => expect(safeLimit(9999, 50, 200)).toBe(200));
  it('coerces a numeric string', () => expect(safeLimit('30', 50, 200)).toBe(30));
  it('falls back on NaN / non-numeric / <1 / undefined', () => {
    expect(safeLimit('abc', 50, 200)).toBe(50);
    expect(safeLimit(Number.NaN, 50, 200)).toBe(50);
    expect(safeLimit(0, 50, 200)).toBe(50);
    expect(safeLimit(undefined, 50, 200)).toBe(50);
  });
});
