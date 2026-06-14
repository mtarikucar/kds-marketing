export type WorkspaceCurrency = 'TRY' | 'USD' | 'EUR' | 'GBP';

const LOCALE_BY_CURRENCY: Record<WorkspaceCurrency, string> = {
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

export function formatMoney(
  amount: number | string | null | undefined,
  currency: WorkspaceCurrency = 'TRY',
  options?: Intl.NumberFormatOptions,
): string {
  const locale = LOCALE_BY_CURRENCY[currency] ?? 'tr-TR';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, ...options }).format(
      toNumber(amount),
    );
  } catch {
    return `${toNumber(amount).toFixed(2)} ${currency}`;
  }
}

export function asWorkspaceCurrency(value: unknown): WorkspaceCurrency {
  return value === 'USD' || value === 'EUR' || value === 'GBP' ? value : 'TRY';
}
