import { describe, it, expect } from 'vitest';
import { fmtTargetValue } from './index';

// COMMISSION_AMOUNT targets are money in TL (Turkish business — the commission
// ledger is in lira). They used to render with a hard-coded `$`, mislabeling lira
// as dollars; they must use the locale-aware money formatter (mirrors the
// PerformancePage fix).
describe('targets fmtTargetValue', () => {
  it('formats a COMMISSION_AMOUNT target as TRY money, not a hard-coded $', () => {
    const out = fmtTargetValue('COMMISSION_AMOUNT', 5000);
    expect(out).not.toContain('$');
    expect(out).toMatch(/₺|TRY/);
  });

  it('renders count metrics as plain numbers', () => {
    expect(fmtTargetValue('LEADS_WON', 12)).toBe('12');
  });
});
