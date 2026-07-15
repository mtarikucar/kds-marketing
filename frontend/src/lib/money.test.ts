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

  it('formats an ARBITRARY ISO currency (e.g. an ad account CAD) with its own symbol, not ₺', () => {
    const out = formatMoney(50, 'CAD');
    expect(out).toMatch(/CA?\$|CAD/); // CA$ / C$ / CAD depending on the runtime ICU
    expect(out).not.toContain('₺'); // must NOT be mislabeled as Turkish Lira
    expect(out).toContain('50');
  });

  it('falls back to "<amount> <CODE>" for an invalid currency code', () => {
    expect(formatMoney(50, 'NOTACODE')).toBe('50.00 NOTACODE');
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
