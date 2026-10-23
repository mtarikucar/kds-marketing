/** A date and time in the panel's language, e.g. `22 Eki 2026 12:00`. */
export function formatDateTime(iso: string | null | undefined, language: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const locale = language === 'tr' ? 'tr-TR' : 'en-GB';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** A whole number in the panel's language, e.g. `1.234` in Turkish. */
export function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language === 'tr' ? 'tr-TR' : 'en-GB').format(value);
}
