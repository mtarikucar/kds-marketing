/** Extract a human-readable message from an axios/Nest error envelope. */
export function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg ?? fallback;
}

/** Format integer cents into a locale price string; '—' when unset. */
export function formatPrice(priceCents: number | null | undefined, currency?: string | null): string {
  if (priceCents == null) return '—';
  const amount = priceCents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: (currency || 'USD').toUpperCase(),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${(currency || '').toUpperCase()}`.trim();
  }
}

/** Major-unit amount → integer cents, rounding to avoid float drift. */
export function toCents(amount: number | undefined): number | undefined {
  if (amount == null || Number.isNaN(amount)) return undefined;
  return Math.round(amount * 100);
}
