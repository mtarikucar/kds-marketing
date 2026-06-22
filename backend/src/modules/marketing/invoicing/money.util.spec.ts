import { computeMoneyTotals } from './money.util';

describe('computeMoneyTotals', () => {
  it('sums line subtotals with no tax', () => {
    const r = computeMoneyTotals([
      { qty: 2, unitPrice: 5000 },
      { qty: 1, unitPrice: 9900 },
    ]);
    expect(r).toEqual({ subtotal: 19900, taxTotal: 0, total: 19900, taxLines: [] });
  });

  it('adds exclusive tax per line and groups the breakdown by rate', () => {
    const r = computeMoneyTotals([
      { qty: 1, unitPrice: 10000, taxRatePct: 20 }, // 2000 tax
      { qty: 2, unitPrice: 5000, taxRatePct: 20 }, // 2000 tax
      { qty: 1, unitPrice: 1000, taxRatePct: 10 }, // 100 tax
    ]);
    expect(r.subtotal).toBe(21000);
    expect(r.taxTotal).toBe(4100);
    expect(r.total).toBe(25100);
    expect(r.taxLines).toEqual([
      { ratePct: 10, tax: 100 },
      { ratePct: 20, tax: 4000 },
    ]);
  });

  it('rounds tax to the nearest minor unit per line', () => {
    // 333 * 18% = 59.94 → 60
    const r = computeMoneyTotals([{ qty: 1, unitPrice: 333, taxRatePct: 18 }]);
    expect(r.taxTotal).toBe(60);
    expect(r.total).toBe(393);
  });

  it('clamps negative/garbage quantities and prices to 0', () => {
    const r = computeMoneyTotals([
      { qty: -3, unitPrice: 1000, taxRatePct: 20 },
      { qty: 1, unitPrice: -50 },
      { qty: 2, unitPrice: 100 },
    ]);
    expect(r.subtotal).toBe(200);
    expect(r.taxTotal).toBe(0);
  });

  it('handles empty/undefined items', () => {
    expect(computeMoneyTotals(undefined)).toEqual({ subtotal: 0, taxTotal: 0, total: 0, taxLines: [] });
  });
});
