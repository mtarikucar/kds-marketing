import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { UseQueryResult } from '@tanstack/react-query';
import * as api from '@/api/social';
import type { PostsOut } from '@/api/posts';
import { Badge, cn, Switch } from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { StudioError, StudioReadStatus } from '../StudioShared';
import { useSocialKey } from './data';
import type { SocialPlace } from './location';

const METRICS: api.Metric[] = ['followers', 'reach', 'views', 'engagement', 'profile_visits'];

/**
 * A metric's days as a small line: a day with no number (or a day not read at all) splits it,
 * never becomes zero; nothing to draw is "—".
 */
export function Sparkline({ days, metric }: { days: api.AccountDay[]; metric: api.Metric }) {
  const { t } = useTranslation();
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  const known = sorted.filter((d) => d[metric] != null);
  const label = t('socialAccounts.trend', { metric: t(`socialAccounts.metrics.${metric}`) });
  if (!known.length) return null;
  const min = Math.min(...known.map((d) => d[metric]!));
  const max = Math.max(...known.map((d) => d[metric]!));
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
    if (day[metric] != null) segment.push({ x: 2 + (span ? (at - first) / span : 0.5) * 116, y: max === min ? 14 : 26 - ((day[metric]! - min) / (max - min)) * 24, day: day.day });
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

/** The account's pause, as a switch; a stale revision is read again, never guessed. */
function PauseSwitch({ account, posts, postsKey }: { account: api.SocialAccount; posts: UseQueryResult<PostsOut>; postsKey: readonly unknown[] }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const key = useSocialKey();
  const settings = posts.data?.settings;
  const revision = settings?.revision;
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.accountPause(account.capability_id, paused, revision!),
    onSuccess: (result) => {
      client.setQueryData<PostsOut>(postsKey, (old) => (old ? { ...old, settings: result } : old));
      client.setQueryData<api.SocialAccount[]>([...key, 'accounts'], (old) => old?.map((a) => ({ ...a, paused: result.paused_capability_ids.includes(a.capability_id) })));
      void client.invalidateQueries({ queryKey: [...key, 'account', account.capability_id] });
      void client.invalidateQueries({ queryKey: [...key, 'packages'] });
    },
    // A stale revision must be read again; never retry a write with a guessed revision.
    onError: () => { void posts.refetch(); },
  });
  const paused = settings?.paused_capability_ids?.includes(account.capability_id) ?? account.paused;
  const label = t(paused ? 'socialAccounts.resume' : 'socialAccounts.pause');
  return (
    <div className="space-y-2">
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <Switch
          checked={paused}
          aria-label={`${account.name} · ${label}`}
          disabled={pause.isPending || posts.isFetching || posts.isError || !Number.isInteger(revision)}
          onCheckedChange={(next) => pause.mutate(next)}
        />
        <span>{t('socialAccounts.pausedSwitch')}</span>
      </label>
      <StudioError error={pause.error} />
    </div>
  );
}

/**
 * The selected account: its state and (for `social.manage`) its pause, its numbers in one row
 * with their change over the period and a small line each, the period, the period's totals,
 * and the posts its platform holds that Jeeta did not leave there.
 */
export function AccountHeader({
  account,
  detail,
  place,
  go,
  manage,
  posts,
  postsKey,
}: {
  account: api.SocialAccount;
  detail: UseQueryResult<api.AccountDetail>;
  place: SocialPlace;
  go: (place: SocialPlace, options?: { replace?: boolean }) => void;
  manage: boolean;
  posts: UseQueryResult<PostsOut>;
  postsKey: readonly unknown[];
}) {
  const { t, i18n } = useTranslation();
  const data = detail.data;
  const days = [...(data?.days ?? [])].sort((a, b) => a.day.localeCompare(b.day));
  const latest = days.at(-1) ?? data?.account.latest ?? account.latest;
  const number = (n: number | null | undefined) => (n == null ? '—' : formatNumber(n, i18n.language));
  const period = place.days ?? 30;
  const locked = account.status !== 'verified';
  const name = `${t(`capabilities.kinds.${account.kind}`)} · ${account.name}`;
  const strays = data?.at_platform?.filter((p) => !p.known) ?? [];
  return (
    <section aria-label={name} className="min-w-0 space-y-4 rounded-lg border border-border bg-surface p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="break-all text-lg font-semibold">{name}</h2>
          <p className="flex flex-wrap gap-2">
            {account.paused && <Badge tone="warning">{t('socialAccounts.paused')}</Badge>}
            {locked && <Badge tone="danger">{t(`status.capability.${account.status}`, { defaultValue: t('socialAccounts.locked') })}</Badge>}
            {account.requires_human_approval && <Badge tone="info">{t('socialAccounts.needsApproval')}</Badge>}
            {!account.paused && !locked && <Badge tone="success">{t('socialAccounts.active')}</Badge>}
          </p>
        </div>
        {manage && <PauseSwitch account={account} posts={posts} postsKey={postsKey} />}
      </header>
      <div role="group" aria-label={t('socialAccounts.period')} className="flex flex-wrap gap-1.5">
        {([7, 30, 90] as const).map((value) => (
          <button key={value} type="button" aria-pressed={period === value} onClick={() => go({ ...place, days: value === 30 ? undefined : value }, { replace: true })}
            className={cn('inline-flex min-h-9 items-center rounded-full border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', period === value ? 'border-transparent bg-primary/10 font-medium text-primary' : 'border-border bg-surface hover:border-border-strong')}>
            {t('socialAccounts.days', { count: value })}
          </button>
        ))}
      </div>
      <StudioReadStatus query={detail} />
      {data && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
    </section>
  );
}
