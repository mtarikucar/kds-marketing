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
  const [rawH, rawM] = (cadence.timeOfDay ?? '09:00').split(':').map((n) => parseInt(n, 10));
  // Clamp defensively so a malformed timeOfDay (e.g. '99:99') can't roll the
  // candidate onto a different UTC day and silently corrupt the schedule.
  const hh = Number.isFinite(rawH) ? Math.min(23, Math.max(0, rawH)) : 0;
  const mm = Number.isFinite(rawM) ? Math.min(59, Math.max(0, rawM)) : 0;
  for (let offset = 0; offset <= 7; offset++) {
    const cand = new Date(from);
    cand.setUTCDate(cand.getUTCDate() + offset);
    cand.setUTCHours(hh, mm, 0, 0);
    if (days.includes(cand.getUTCDay()) && cand.getTime() > from.getTime()) return cand;
  }
  return null;
}
