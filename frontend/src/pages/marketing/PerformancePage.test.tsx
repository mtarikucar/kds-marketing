import { describe, it, expect } from 'vitest';
import { fmtValue } from './PerformancePage';

// The COMMISSION_AMOUNT target is a money value denominated in TL (this is a
// Turkish business; the commission ledger is in lira — the settlement consumer
// even notifies "komisyon: X TL"). It used to render with a hard-coded `$`,
// mislabeling lira as dollars. It must use the locale-aware money formatter.
describe('PerformancePage.fmtValue', () => {
  it('formats COMMISSION_AMOUNT as TRY money, not a hard-coded $', () => {
    const out = fmtValue('COMMISSION_AMOUNT', 5000);
    expect(out).not.toContain('$');
    expect(out).toMatch(/₺|TRY/); // tr-TR Intl symbol, or the TRY fallback
  });

  it('renders count metrics as plain numbers', () => {
    expect(fmtValue('LEADS_WON', 12)).toBe('12');
  });

  it('renders a dash for a missing value', () => {
    expect(fmtValue('COMMISSION_AMOUNT', null)).toBe('—');
  });
});
