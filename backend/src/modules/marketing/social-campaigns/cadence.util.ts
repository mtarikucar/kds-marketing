export interface Cadence {
  perWeek?: number;
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek: number[];
  /** 'HH:MM', interpreted in UTC; `timezone` is stored for display only. */
  timeOfDay: string;
  timezone?: string;
}

/**
 * The next slot strictly after `from` whose weekday is one of cadence.daysOfWeek
 * at cadence.timeOfDay (UTC). Scans the next 8 days (covers same-day-later plus
 * a full week wrap). Returns null when no weekday is configured.
 */
export function nextCadenceSlot(cadence: Cadence, from: Date): Date | null {
  const days = (cadence.daysOfWeek ?? []).filter((d) => d >= 0 && d <= 6);
  if (days.length === 0) return null;
  const [hh, mm] = (cadence.timeOfDay ?? '09:00').split(':').map((n) => parseInt(n, 10));
  for (let offset = 0; offset <= 7; offset++) {
    const cand = new Date(from);
    cand.setUTCDate(cand.getUTCDate() + offset);
    cand.setUTCHours(hh || 0, mm || 0, 0, 0);
    if (days.includes(cand.getUTCDay()) && cand.getTime() > from.getTime()) return cand;
  }
  return null;
}
