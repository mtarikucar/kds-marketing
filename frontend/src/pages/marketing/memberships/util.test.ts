import { describe, it, expect } from 'vitest';
import { coursePriceCents, toCents, formatPrice } from './util';

describe('coursePriceCents', () => {
  it('returns null (Free) when the price is cleared — so a paid course can revert to free', () => {
    // The edit form previously OMITTED priceCents on an empty price, leaving the
    // old paid price in place; clearing must send null to actually free it.
    expect(coursePriceCents(undefined)).toBeNull();
    expect(coursePriceCents('')).toBeNull();
  });

  it('converts a real amount to integer cents', () => {
    expect(coursePriceCents(49.99)).toBe(4999);
  });

  it('keeps an explicit 0 as 0 cents ($0.00), distinct from Free/null', () => {
    expect(coursePriceCents(0)).toBe(0);
  });
});

describe('toCents', () => {
  it('rounds a major amount to integer cents and passes NaN/undefined through', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(undefined)).toBeUndefined();
    expect(toCents(Number('abc'))).toBeUndefined();
  });
});

describe('formatPrice', () => {
  it('shows an em dash when the price is unset (Free)', () => {
    expect(formatPrice(null)).toBe('—');
  });
});
