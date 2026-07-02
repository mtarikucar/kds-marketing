/** Small, pure, locale-injected formatters for the social-campaign UI. */

export interface CadenceLike {
  perWeek?: number;
  daysOfWeek?: number[]; // 0=Sun … 6=Sat
  timeOfDay?: string; // 'HH:mm'
}

/** "3× · Mon, Wed · 09:00" — day names are injected so it stays locale-aware. */
export function cadenceSummary(cadence: CadenceLike | null | undefined, dayShortNames: string[]): string {
  if (!cadence) return '';
  const days = (cadence.daysOfWeek ?? [])
    .map((d) => dayShortNames[d])
    .filter(Boolean)
    .join(', ');
  const parts: string[] = [];
  if (cadence.perWeek && cadence.perWeek > 0) parts.push(`${cadence.perWeek}×`);
  if (days) parts.push(days);
  if (cadence.timeOfDay) parts.push(cadence.timeOfDay);
  return parts.join(' · ');
}

/** Locale-aware relative time ("in 2 hours" / "3 days ago"), coarsened to the
 *  most natural unit. `now` injected for determinism/testability. */
export function relativeFromNow(iso: string, now: Date, locale: string): string {
  const diffMs = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const MIN = 60_000;
  const HR = 3_600_000;
  const DAY = 86_400_000;
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
  if (abs < MIN) return rtf.format(0, 'minute');
  if (abs < HR) return rtf.format(Math.round(diffMs / MIN), 'minute');
  if (abs < DAY) return rtf.format(Math.round(diffMs / HR), 'hour');
  return rtf.format(Math.round(diffMs / DAY), 'day');
}
