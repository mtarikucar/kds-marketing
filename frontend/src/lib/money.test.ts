import { describe, it, expect } from 'vitest';
import { formatMoney, asWorkspaceCurrency } from './money';

describe('formatMoney', () => {
  it('defaults to TRY: shows the lira symbol and dot grouping', () => {
    const out = formatMoney(2690);
    expect(out).toContain('₺');
    // tr-TR groups thousands with a dot.
    expect(out).toContain('2.690');
  });

  it('formats a USD number with the dollar sign and two decimals', () => {
    expect(formatMoney(79, 'USD')).toBe('$79.00');
  });

  it('coerces null to zero (USD)', () => {
    expect(formatMoney(null, 'USD')).toBe('$0.00');
  });
});

describe('asWorkspaceCurrency', () => {
  it('narrows an unknown value to the TRY default', () => {
    expect(asWorkspaceCurrency(undefined)).toBe('TRY');
    expect(asWorkspaceCurrency('ABC')).toBe('TRY');
    expect(asWorkspaceCurrency(123)).toBe('TRY');
  });

  it('passes through the supported currencies', () => {
    expect(asWorkspaceCurrency('USD')).toBe('USD');
    expect(asWorkspaceCurrency('EUR')).toBe('EUR');
    expect(asWorkspaceCurrency('GBP')).toBe('GBP');
  });
});
