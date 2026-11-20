import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/social';
import { useSession } from '@/auth/useSession';
import { cn } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { StudioReadStatus } from '../StudioShared';

const METRICS: api.Metric[] = ['followers', 'reach', 'views', 'engagement', 'profile_visits'];

/**
 * The band of values a sparkline's height stands for. Min to max alone turns one follower on 69
 * into a cliff, so the band is never narrower than a sixth of the largest value (1 when every
 * value is 0), centred on the values: a ±1 change on 69 is a step of about a twelfth of the
 * height, a flat series a flat line in the middle, and a move of 20% or more fills the height.
 * `null` when no value is known.
 */
export function sparkBand(values: (number | null | undefined)[]): { lo: number; hi: number } | null {
  const known = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (!known.length) return null;
  const min = Math.min(...known);
  const max = Math.max(...known);
  const range = Math.max(max - min, Math.max(Math.abs(min), Math.abs(max)) / 6 || 1);
  const mid = (min + max) / 2;
  return { lo: mid - range / 2, hi: mid + range / 2 };
}

/** Where `value` sits in a 28-high sparkline drawn in `band`: 26 at its bottom, 2 at its top. */
export const sparkY = (band: { lo: number; hi: number }, value: number) => 26 - ((value - band.lo) / (band.hi - band.lo)) * 24;

/**
 * A metric's days as a small line: a day with no number (or a day not read at all) splits it,
 * never becomes zero; nothing to draw is "—".
 */
export function Sparkline({ days, metric }: { days: api.AccountDay[]; metric: api.Metric }) {
  const { t } = useTranslation();
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const label = t('socialAccounts.trend', { metric: t(`socialAccounts.metrics.${metric}`) });
  const band = sparkBand(sorted.map((d) => d[metric]));
  if (!band) return null;
  const first = Date.parse(sorted[0].day);
  const span = Date.parse(sorted.at(-1)!.day) - first;
  const segments: { x: number; y: number; day: string }[][] = [];
  let segment: (typeof segments)[number] = [];
  let previous: number | undefined;
  for (const day of sorted) {
    const at = Date.parse(day.day);
    if (day[metric] == null || (previous !== undefined && at - previous > 86_400_000)) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (day[metric] != null) segment.push({ x: 2 + (span ? (at - first) / span : 0.5) * 116, y: sparkY(band, day[metric]!), day: day.day });
    previous = at;
  }
  if (segment.length) segments.push(segment);
  return (
    <svg role="img" aria-label={label} viewBox="0 0 120 28" preserveAspectRatio="none" className="h-7 w-full text-primary">
      <title>{label}</title>
      {segments.map((points, i) => (
        <g key={i}>
          {points.length > 1 && <polyline points={points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
          {points.length === 1 && <circle cx={points[0].x} cy={points[0].y} r="1.5" fill="currentColor" />}
        </g>
      ))}
    </svg>
  );
}

/** The first and last day of a period of `days` days ending today (as the server reads them). */
export function periodRange(days: number): { from: string; until: string } {
  const until = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(until) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, until };
}

/**
 * An account's numbers ("Sayılar" in Hesaplar, design 2026-11-19 §2.9.2): its metrics in one row
 * with their change over the period and a small line each, the period (7, 30 or 90 days), the
 * period's totals, and the posts its platform holds that Jeeta did not leave there. Read only
 * while shown (`social.account_get`): never one read per account when the page opens.
 */
export function AccountNumbers({ account, days: period, onDays }: { account: api.SocialAccount; days: 7 | 30 | 90; onDays: (days: 7 | 30 | 90) => void }) {
  const { t, i18n } = useTranslation();
  const workspace = useSession().data?.current_workspace;
  const { from, until } = periodRange(period);
  const detail = useQuery({
    queryKey: ['social', workspace, 'account', account.capability_id, from, until],
    queryFn: () => api.accountGet(account.capability_id, from, until),
    refetchInterval: 60_000,
  });
  const data = detail.data;
  const days = [...(data?.days ?? [])].sort((a, b) => a.day.localeCompare(b.day));
  const latest = days.at(-1) ?? data?.account.latest ?? account.latest;
  const number = (n: number | null | undefined) => (n == null ? '—' : formatNumber(n, i18n.language));
  const strays = data?.at_platform?.filter((p) => !p.known) ?? [];
  return (
    <div className="min-w-0 space-y-4">
      <div role="group" aria-label={t('socialAccounts.period')} className="flex flex-wrap gap-1.5">
        {([7, 30, 90] as const).map((value) => (
          <button key={value} type="button" aria-pressed={period === value} onClick={() => onDays(value)}
            className={cn('inline-flex min-h-9 items-center rounded-full border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', period === value ? 'border-transparent bg-primary/10 font-medium text-primary' : 'border-border bg-surface hover:border-border-strong')}>
            {t('socialAccounts.days', { count: value })}
          </button>
        ))}
      </div>
      <StudioReadStatus query={detail} />
      {data && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {METRICS.map((metric) => {
              const start = days[0]?.[metric];
              const end = days.at(-1)?.[metric];
              const change = days.length < 2 || start == null || end == null ? null : end - start;
              return (
                <div key={metric} data-testid={`metric-${metric}`} className="min-w-0 space-y-1 rounded-md bg-surface-muted/60 px-3 py-2">
                  <dt className="truncate text-xs text-muted-foreground">{t(`socialAccounts.metrics.${metric}`)}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{number(latest?.[metric])}</dd>
                  <dd className={cn('text-xs tabular-nums', change == null || change === 0 ? 'text-muted-foreground' : change > 0 ? 'text-success' : 'text-danger')}>
                    <span className="sr-only">{t('socialAccounts.change')}: </span>
                    {change == null ? '—' : `${change > 0 ? '+' : ''}${number(change)}`}
                  </dd>
                  <dd><Sparkline days={days} metric={metric} /></dd>
                </div>
              );
            })}
          </dl>
          <dl aria-label={t('socialAccounts.totals')} className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('socialAccounts.totals')}:</dt>
            {(['posts', 'reach', 'views', 'engagement'] as const).map((metric) => (
              <div key={metric} className="flex gap-1.5">
                <dt className="text-muted-foreground">{t(`socialAccounts.metrics.${metric}`)}</dt>
                <dd className="font-medium tabular-nums">{number(data.totals[metric])}</dd>
              </div>
            ))}
          </dl>
          {strays.length > 0 && (
            <section aria-label={t('socialAccounts.strays')} className="space-y-2 rounded-md border-s-2 border-warning bg-warning-subtle p-3 text-sm">
              <h3 className="font-semibold">{t('socialAccounts.strays')}</h3>
              <p>{t('socialAccounts.straysHelp')}</p>
              <ul className="list-disc space-y-1 ps-5">
                {strays.map((p) => (
                  <li key={p.external_id} className="break-words">
                    <time dateTime={p.publish_at}>{formatDateTime(p.publish_at, i18n.language)}</time>
                    {p.title ? ` · ${p.title}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
