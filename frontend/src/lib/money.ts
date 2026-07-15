export type WorkspaceCurrency = 'TRY' | 'USD' | 'EUR' | 'GBP';

// Only the workspace currencies get a hand-picked grouping locale; any OTHER
// valid ISO code (e.g. an ad account's provider currency: CAD/JPY/BRL/…) falls
// back to the viewer's default locale so its symbol is still rendered correctly.
const LOCALE_BY_CURRENCY: Record<string, string> = {
  TRY: 'tr-TR',
  USD: 'en-US',
  EUR: 'de-DE',
  GBP: 'en-GB',
};

function toNumber(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Format money in the given currency. Accepts ANY ISO 4217 code (not just the 4
 * workspace currencies) so a provider currency like CAD renders as C$ instead of
 * being mislabeled — Intl.NumberFormat resolves the symbol from the code, and an
 * invalid code falls back to "<amount> <CODE>".
 */
export function formatMoney(
  amount: number | string | null | undefined,
  currency: string = 'TRY',
  options?: Intl.NumberFormatOptions,
): string {
  const code = (currency || 'TRY').toUpperCase();
  const locale = LOCALE_BY_CURRENCY[code]; // undefined for an unmapped code → viewer default
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code, ...options }).format(
      toNumber(amount),
    );
  } catch {
    return `${toNumber(amount).toFixed(2)} ${code}`;
  }
}

export function asWorkspaceCurrency(value: unknown): WorkspaceCurrency {
  return value === 'USD' || value === 'EUR' || value === 'GBP' ? value : 'TRY';
}
