/**
 * Shared money math for priced documents (invoices, estimates, order forms).
 * All amounts are minor units (kuruş/cents). Tax is EXCLUSIVE — each line's tax
 * is added on top of (qty × unitPrice). `taxRatePct` is the per-line snapshot
 * resolved from the workspace's TaxRate at write time (so editing a rate later
 * never rewrites historical totals).
 */

export interface PricedItem {
  description?: string;
  qty: number;
  unitPrice: number; // minor units
  /** Resolved tax rate snapshot for this line, percent (20 = 20%). */
  taxRatePct?: number;
  /** The TaxRate this line references (kept for the editor; pct is the source of truth). */
  taxRateId?: string | null;
}

export interface MoneyTotals {
  subtotal: number;
  taxTotal: number;
  total: number;
  /** Tax grouped by rate, for the summary panel. */
  taxLines: { ratePct: number; tax: number }[];
}

/** PostgreSQL int4 ceiling — the subtotal/taxTotal/total columns are INTEGER. */
export const PG_INT_MAX = 2_147_483_647;

const cleanInt = (v: unknown): number => Math.max(0, Math.round(Number(v) || 0));

/** Compute subtotal / taxTotal / total + a per-rate tax breakdown. */
export function computeMoneyTotals(items: PricedItem[] | undefined | null): MoneyTotals {
  let subtotal = 0;
  let taxTotal = 0;
  const byRate = new Map<number, number>();
  for (const it of items ?? []) {
    const line = cleanInt(it.qty) * cleanInt(it.unitPrice);
    subtotal += line;
    const pct = Math.max(0, Number(it.taxRatePct) || 0);
    if (pct > 0 && line > 0) {
      const tax = Math.round((line * pct) / 100);
      taxTotal += tax;
      byRate.set(pct, (byRate.get(pct) ?? 0) + tax);
    }
  }
  return {
    subtotal,
    taxTotal,
    total: subtotal + taxTotal,
    taxLines: [...byRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ratePct, tax]) => ({ ratePct, tax })),
  };
}
