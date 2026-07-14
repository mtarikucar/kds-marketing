import { describe, it, expect } from 'vitest';
import { normalizeInvoiceItems, computeInvoiceTotals } from './InvoiceForm';

const pctOf = (id?: string) => (id === 'tr1' ? 20 : 0);

// The live total preview and the POST payload must agree. Both derive from
// normalizeInvoiceItems, so a description-less line (dropped on save) or a
// cleared qty (billed as 1) can no longer make the preview disagree with the
// amount the customer is actually invoiced.
describe('normalizeInvoiceItems', () => {
  it('drops blank-description lines and converts price to minor units', () => {
    const rows = normalizeInvoiceItems([
      { description: 'Plan', qty: 2, price: '99', taxRateId: 'tr1' },
      { description: '', qty: 5, price: '50' }, // no description → dropped on save
    ]);
    expect(rows).toEqual([
      { description: 'Plan', qty: 2, unitPrice: 9900, taxRateId: 'tr1' },
    ]);
  });

  it('defaults a cleared/zero qty to 1 (what actually gets billed)', () => {
    const rows = normalizeInvoiceItems([{ description: 'X', qty: 0, price: '10' }]);
    expect(rows[0].qty).toBe(1);
  });

  it('coerces a fractional qty to an integer and clamps qty/price to the backend @Max(1_000_000)', () => {
    const rows = normalizeInvoiceItems([
      { description: 'A', qty: 2.5, price: '50' }, // fractional → integer (backend @IsInt)
      { description: 'B', qty: 9_999_999, price: '50' }, // qty over max → clamped
      { description: 'C', qty: 1, price: '20000' }, // 20000*100 = 2,000,000 kuruş → clamped
    ]);
    expect(rows[0].qty).toBe(3);
    expect(rows[1].qty).toBe(1_000_000);
    expect(rows[2].unitPrice).toBe(1_000_000);
  });
});

describe('computeInvoiceTotals', () => {
  it('excludes blank-description lines so the preview equals the saved total', () => {
    const totals = computeInvoiceTotals(
      [
        { description: 'Plan', qty: 1, price: '99', taxRateId: 'tr1' }, // 9900 + 20% = 11880
        { description: '', qty: 5, price: '50' }, // blank → must NOT inflate the preview
      ],
      pctOf,
    );
    expect(totals.subtotal).toBe(9900);
    expect(totals.tax).toBe(1980);
    expect(totals.total).toBe(11880);
  });

  it('counts a qty-0 line as the billed qty 1, so preview matches the invoice', () => {
    const totals = computeInvoiceTotals([{ description: 'X', qty: 0, price: '10' }], pctOf);
    expect(totals.subtotal).toBe(1000); // qty 1 × 1000 minor units
    expect(totals.total).toBe(1000);
  });

  it('sums described lines with per-line exclusive tax in minor units', () => {
    const totals = computeInvoiceTotals(
      [
        { description: 'A', qty: 2, price: '10', taxRateId: 'tr1' }, // 2000 + 20% = 2400
        { description: 'B', qty: 1, price: '5' }, // 500, no tax
      ],
      pctOf,
    );
    expect(totals.subtotal).toBe(2500);
    expect(totals.tax).toBe(400);
    expect(totals.total).toBe(2900);
  });
});
