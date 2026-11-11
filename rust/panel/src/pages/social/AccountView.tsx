import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/social';
import { formatDateTime, formatNumber } from '@/lib/format';
import { buttonClass, StudioReadStatus } from '../StudioShared';
import { AccountTrend } from './AccountTrend';

const metrics: api.Metric[] = ['followers', 'reach', 'views', 'engagement', 'profile_visits'];
export function AccountView({ account, queryKey, back }: { account: api.SocialAccount; queryKey: readonly unknown[]; back: () => void }) {
  const { t, i18n } = useTranslation();
  const [period, setPeriod] = useState(30);
  const [trend, setTrend] = useState<api.Metric>('followers');
  const until = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(until) - (period - 1) * 86400000).toISOString().slice(0, 10);
  const detail = useQuery({ queryKey: [...queryKey, 'account', account.capability_id, from, until], queryFn: () => api.accountGet(account.capability_id, from, until) });
  const data = detail.data;
  const number = (n: number | null | undefined) => n == null ? '—' : formatNumber(n, i18n.language);
  const format = (f: string) => t(`posts.format.${f}`, { defaultValue: f });
  const name = `${t(`capabilities.kinds.${account.kind}`)} · ${account.name}`;
  const days = [...(data?.days ?? [])].sort((a, b) => a.day.localeCompare(b.day));
  const latest = days.at(-1) ?? data?.account.latest;
  // Prefer metrics this platform actually supplied; keep every unavailable metric visible as —.
  const ordered = [...metrics].sort((a, b) => Number(latest?.[b] != null) - Number(latest?.[a] != null));
  return <section aria-label={name} className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
    <button className={`${buttonClass} md:hidden`} onClick={back}>{t('socialAccounts.back')}</button>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">{name}</h2>
        {account.paused && <p className="text-sm text-muted-foreground">{t('socialAccounts.paused')}</p>}
        {account.status !== 'verified' && <p className="text-sm text-muted-foreground">{t(`status.capability.${account.status}`, { defaultValue: t('socialAccounts.locked') })}</p>}
      </div>
      <div role="group" aria-label={t('socialAccounts.period')} className="flex flex-wrap gap-1">
        {[7, 30, 90].map(value => <button key={value} className={`${buttonClass} aria-pressed:bg-surface-muted`} aria-pressed={period === value} onClick={() => setPeriod(value)}>{t('socialAccounts.days', { count: value })}</button>)}
      </div>
    </header>
    <StudioReadStatus query={detail} />
    {data && <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4">
        {ordered.map((metric, index) => {
          const start = days[0]?.[metric];
          const end = days.at(-1)?.[metric];
          const change = days.length < 2 || start == null || end == null ? null : end - start;
          return <div key={metric} data-testid={`metric-${metric}`} className={index >= 4 ? 'col-span-2 flex flex-wrap items-baseline gap-x-3 border-t border-border pt-3 text-sm lg:col-span-4' : 'space-y-1'}>
            <dt className="text-sm text-muted-foreground">{t(`socialAccounts.metrics.${metric}`)}</dt>
            <dd className={index < 4 ? 'text-2xl font-semibold tabular-nums' : 'tabular-nums'}>{number(latest?.[metric])}</dd>
            <dd className="text-xs text-muted-foreground">{t('socialAccounts.change')}: {change == null ? '—' : `${change > 0 ? '+' : ''}${number(change)}`}</dd>
          </div>;
        })}
      </dl>
      <div className="space-y-3 border-y border-border py-4">
        <label className="flex flex-wrap items-center gap-2 text-sm">{t('socialAccounts.trendMetric')}
          <select className="min-h-10 rounded border border-border bg-surface px-2" value={trend} onChange={e => setTrend(e.target.value as api.Metric)}>{ordered.map(metric => <option key={metric} value={metric}>{t(`socialAccounts.metrics.${metric}`)}</option>)}</select>
        </label>
        <AccountTrend days={days} metric={trend} />
      </div>
      <section aria-label={t('socialAccounts.totals')} className="space-y-2">
        <h3 className="text-sm font-medium">{t('socialAccounts.totals')}</h3>
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">{(['posts', 'reach', 'views', 'engagement'] as const).map(metric => <div key={metric} className="flex gap-2"><dt className="text-muted-foreground">{t(`socialAccounts.metrics.${metric}`)}</dt><dd className="tabular-nums">{number(data.totals[metric])}</dd></div>)}</dl>
      </section>
      <section aria-label={t('socialAccounts.upcoming')} className="space-y-3">
        <h3 className="font-semibold">{t('socialAccounts.upcoming')}</h3>
        {!data.upcoming.length && <p className="text-sm text-muted-foreground">{t('socialAccounts.noUpcoming')}</p>}
        <ul className="divide-y divide-border">{[...data.upcoming].sort((a, b) => a.publish_at.localeCompare(b.publish_at)).map(post => <li key={post.slot_id} className="space-y-1 py-3 text-sm">
          <time dateTime={post.publish_at} className="text-xs text-muted-foreground">{formatDateTime(post.publish_at, i18n.language)}</time>
          <p className="font-medium">{post.title}</p><p className="text-muted-foreground">{format(post.format)}</p>
          {post.state === 'waiting_person'
            ? <Link className="inline-block min-h-10 py-2 text-primary underline" to={`/social?${post.waits_for === 'approval' ? 'slot' : 'tiktok'}=${encodeURIComponent(post.slot_id)}`}>{t(post.waits_for === 'approval' ? 'socialAccounts.waitingApproval' : 'socialAccounts.waitingPerson')}</Link>
            : <span className="inline-block rounded bg-surface-muted px-2 py-1 text-xs">{t(post.state === 'held' ? 'socialAccounts.held' : post.held_at_provider ? 'socialAccounts.atProvider' : 'socialAccounts.byJeeta')}</span>}
        </li>)}</ul>
      </section>
      {data.at_platform?.some(post => !post.known) && <section aria-label={t('socialAccounts.strays')} className="space-y-2 border-s-2 border-warning bg-warning-subtle p-3 text-sm">
        <h3 className="font-semibold">{t('socialAccounts.strays')}</h3>
        <p>{t('socialAccounts.straysHelp')}</p>
        <ul className="list-disc space-y-1 ps-5">{data.at_platform.filter(post => !post.known).map(post => <li key={post.external_id} className="break-words">
          <time dateTime={post.publish_at}>{formatDateTime(post.publish_at, i18n.language)}</time>{post.title ? ` · ${post.title}` : ''}
        </li>)}</ul>
      </section>}
      <section aria-label={t('socialAccounts.recent')} className="space-y-3">
        <h3 className="font-semibold">{t('socialAccounts.recent')}</h3>
        {!data.recent.length && <p className="text-sm text-muted-foreground">{t('socialAccounts.noRecent')}</p>}
        <ul className="divide-y divide-border">{[...data.recent].sort((a, b) => b.published_at.localeCompare(a.published_at)).map(post => <li key={post.slot_id} data-testid={`recent-${post.slot_id}`} className="space-y-1 py-3 text-sm">
          <time dateTime={post.published_at} className="text-xs text-muted-foreground">{formatDateTime(post.published_at, i18n.language)}</time>
          <p className="font-medium">{post.url && /^https?:\/\//i.test(post.url) ? <a className="text-primary underline" href={post.url} target="_blank" rel="noopener noreferrer">{post.title}</a> : post.title}</p>
          {post.format && <p className="text-muted-foreground">{format(post.format)}</p>}
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{(['reach', 'views', 'engagement'] as const).map(metric => <li key={metric}>{t(`socialAccounts.metrics.${metric}`)}: {number(post.metrics[metric])}</li>)}</ul>
        </li>)}</ul>
      </section>
    </>}
  </section>;
}
