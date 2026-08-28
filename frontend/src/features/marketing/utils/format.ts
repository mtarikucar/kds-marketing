import i18n from 'i18next';

/**
 * Format a date using the current i18n language rather than the
 * browser's OS-level default. Multiple marketing components used
 * `new Date(x).toLocaleDateString()` directly, which on a Turkish
 * admin's machine often resolved to `en-US` because the OS shipped
 * that as the default. Threading i18next.language keeps all marketing
 * UI dates consistent with the locale the rest of the page renders.
 */
function getLocale(): string {
  return i18n.language || 'tr';
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleDateString(getLocale());
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleString(getLocale());
}

/**
 * Format a call duration in seconds as `m:ss` (e.g. 95 → "1:35").
 * Empty/nullish → "—". Used by the sales-call log.
 */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format an instant as a compact calendar slot — "29 Ağu 09:00".
 *
 * `fmtDateTime` is the right answer for a record's own timestamp, but a
 * calendar list is a column of them: the year and the seconds are the same on
 * every row, so they are noise that pushes the one thing that differs — the
 * title — off the line. Locale still comes from i18next, not the OS.
 */
export function fmtSlot(d: string | Date | null | undefined): string {
  if (!d) return '';
  return new Date(d).toLocaleString(getLocale(), {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
