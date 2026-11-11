import { useTranslation } from 'react-i18next';
import type { AccountDay, Metric } from '@/api/social';
import { formatNumber } from '@/lib/format';

/** Missing observations (including omitted days) split the line instead of becoming zero. */
export function AccountTrend({ days, metric }: { days: AccountDay[]; metric: Metric }) {
  const { t, i18n } = useTranslation();
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const known = sorted.filter(day => day[metric] != null);
  const label = t('socialAccounts.trend', { metric: t(`socialAccounts.metrics.${metric}`) });
  if (!known.length) return <p className="py-8 text-sm text-muted-foreground">{label}: —</p>;
  const min = Math.min(...known.map(day => day[metric]!));
  const max = Math.max(...known.map(day => day[metric]!));
  const first = Date.parse(sorted[0].day);
  const span = Date.parse(sorted.at(-1)!.day) - first;
  const segments: { x: number; y: number; day: string; value: number }[][] = [];
  let segment: typeof segments[number] = [];
  let previous: number | undefined;
  for (const day of sorted) {
    const instant = Date.parse(day.day);
    if (day[metric] == null || (previous !== undefined && instant - previous > 86400000)) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (day[metric] != null) segment.push({ x: 12 + (span ? (instant - first) / span : 0.5) * 576, y: max === min ? 80 : 144 - (day[metric]! - min) / (max - min) * 128, day: day.day, value: day[metric]! });
    previous = instant;
  }
  if (segment.length) segments.push(segment);
  return <figure className="min-w-0 space-y-2">
    <figcaption className="flex justify-between gap-2 text-xs text-muted-foreground"><span>{label}</span><span>{formatNumber(min, i18n.language)}–{formatNumber(max, i18n.language)}</span></figcaption>
    <svg role="img" aria-label={label} viewBox="0 0 600 160" className="h-40 w-full text-primary">
      <title>{label}</title>
      {segments.map((points, i) => <g key={i}>
        {points.length > 1 && <polyline points={points.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" />}
        {points.map(point => <circle key={point.day} cx={point.x} cy={point.y} r="3" fill="currentColor"><title>{point.day}: {formatNumber(point.value, i18n.language)}</title></circle>)}
      </g>)}
    </svg>
    <div className="flex justify-between text-xs text-muted-foreground"><time>{sorted[0].day}</time><time>{sorted.at(-1)!.day}</time></div>
  </figure>;
}
