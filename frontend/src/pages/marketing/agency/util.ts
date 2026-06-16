/** Extract a human-readable message from an axios/Nest error envelope. */
export function apiError(e: unknown, fallback: string): string {
  const data = (e as { response?: { data?: { message?: unknown } } })?.response?.data;
  const msg = data?.message;
  if (Array.isArray(msg)) return String(msg[0]);
  if (typeof msg === 'string') return msg;
  // Nest can serialise the thrown object body ({ code, message }) as `message`.
  if (msg && typeof msg === 'object' && 'message' in (msg as Record<string, unknown>)) {
    return String((msg as Record<string, unknown>).message);
  }
  return fallback;
}

/**
 * True when the error is the env-gated rebilling "not configured" 503 the backend
 * raises (REBILLING_NOT_CONFIGURED) when Stripe Connect is unset OR the location
 * has no connected account. The UI surfaces a clean state for this rather than a
 * crash. Detected defensively against both the structured `code` and the message.
 */
export function isRebillingNotConfigured(e: unknown): boolean {
  const resp = (e as { response?: { status?: number; data?: { message?: unknown } } })?.response;
  if (!resp) return false;
  const m = resp.data?.message;
  const code =
    m && typeof m === 'object' && 'code' in (m as Record<string, unknown>)
      ? String((m as Record<string, unknown>).code)
      : undefined;
  if (code === 'REBILLING_NOT_CONFIGURED') return true;
  const text =
    typeof m === 'string'
      ? m
      : m && typeof m === 'object' && 'message' in (m as Record<string, unknown>)
        ? String((m as Record<string, unknown>).message)
        : '';
  return resp.status === 503 && /rebilling not configured/i.test(text);
}

/** Format a Decimal-string money amount into a locale currency string. */
export function formatMoney(amount: string | number | null | undefined, currency = 'TRY'): string {
  if (amount == null || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: (currency || 'TRY').toUpperCase(),
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${(currency || '').toUpperCase()}`.trim();
  }
}

/** A YYYY-MM-DD date input value → ISO-8601 string at UTC midnight. */
export function dateInputToIso(value: string): string {
  if (!value) return value;
  // `new Date('YYYY-MM-DD')` is parsed as UTC midnight — exactly the half-open
  // window boundary the backend expects.
  return new Date(`${value}T00:00:00.000Z`).toISOString();
}

/** Format an ISO date string as a short local date; '—' when empty. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString();
}
