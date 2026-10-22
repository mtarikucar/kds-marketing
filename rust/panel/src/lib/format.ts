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

/**
 * How long ago `iso` was, relative to `now`, in the panel's language (e.g. `3 saat önce`); the
 * largest unit that fits, from seconds to days.
 */
export function formatRelative(iso: string | null | undefined, language: string, now: Date = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language === 'tr' ? 'tr-TR' : 'en-GB', { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}

/** The number of minor-unit digits of an ISO 4217 currency (2 for TRY, 0 for JPY). */
export function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** An amount in minor units of `currency`, as money in the panel's language (e.g. `1.250,00 ₺`). */
export function formatMoney(minor: number, currency: string, language: string): string {
  const digits = minorDigits(currency);
  const locale = language === 'tr' ? 'tr-TR' : 'en-GB';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 10 ** digits);
  } catch {
    return `${formatNumber(minor, language)} ${currency}`;
  }
}

/**
 * A decimal amount typed by a person (`12,50` or `12.50`) in minor units with `digits` decimals,
 * or `null` when it is not a number with at most that many decimals.
 */
export function parseMinor(text: string, digits: number): number | null {
  const normalised = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalised)) return null;
  const [whole, fraction = ''] = normalised.replace('-', '').split('.');
  if (fraction.length > digits) return null;
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  if (!Number.isSafeInteger(minor)) return null;
  return normalised.startsWith('-') ? -minor : minor;
}

/** ISO weekday `day` (1 = Monday … 7 = Sunday) as a short name in the panel's language. */
export function weekdayName(day: number, language: string): string {
  // 2024-01-01 was a Monday.
  const date = new Date(Date.UTC(2024, 0, day));
  return new Intl.DateTimeFormat(language === 'tr' ? 'tr-TR' : 'en-GB', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(date);
}

/** An hour of the day as `09:00`; 24 is the end of the day. */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}
