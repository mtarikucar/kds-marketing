import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { AiUsageDashboard } from '@/features/marketing/api/aiUsageDashboard.service';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { usageNumbers } from './usagePresentation';

export function AiUsageOverview({ query }: { query: UseQueryResult<AiUsageDashboard, Error> }) {
  const { t, i18n } = useTranslation('marketing');
  const titleId = useId();
  const { number, money } = usageNumbers(i18n.language);
  // On a failed refresh, stale analytics must not look current or become zero.
  const data = query.isError ? undefined : query.data;
  const forecast = data?.forecast;
  const allUnpriced = data && data.totals.calls > 0 && data.rows.every(row => row.costUsd == null);
  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id={titleId} className="font-display text-h3">{t('aiModels.usage.title', 'Monthly usage')}</h2>
          {data && <span className="text-caption text-muted-foreground">{data.period.month} · {data.period.timezone}</span>}
          {data?.coverage.partial && <Badge size="sm" tone="warning">{t('aiModels.usage.partial', 'Partial estimate')}</Badge>}
        </div>
        <Button variant="ghost" size="sm" disabled={query.isFetching} onClick={() => query.refetch()}>
          <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          {t('aiModels.usage.refresh', 'Refresh usage')}
        </Button>
      </div>
      {query.isError ? (
        <p role="alert" className="px-4 py-4 text-sm text-danger">{t('aiModels.usage.unavailable', 'Usage is unavailable. Refresh to retry; settings are still available.')}</p>
      ) : !data ? (
        <p role="status" className="px-4 py-4 text-sm text-muted-foreground">{t('aiModels.usage.loading', 'Loading recorded usage…')}</p>
      ) : <>
        <dl className="grid grid-cols-2 gap-y-3 py-2 sm:grid-cols-4">
          {[
            [t('aiModels.usage.tokens', 'Recorded API tokens'), number(data.totals.tokens)],
            [t('aiModels.usage.cost', 'Known estimate · USD'), money(allUnpriced ? null : data.totals.knownCostUsd)],
            [t('aiModels.usage.forecastTokens', 'Month-end tokens'), number(forecast?.tokens)],
            [t('aiModels.usage.forecastCost', 'Month-end estimate · USD'), money(forecast?.costUsd)],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 border-s border-border px-4 first:border-0">
              <dt className="text-caption text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-display text-h2 tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-caption text-muted-foreground">
          {data.daily.length > 1 && data.totals.tokens > 0 && (
            <svg viewBox="0 0 160 24" role="img" aria-label={t('aiModels.usage.trend', 'Daily recorded API tokens this month')} className="h-6 w-40 shrink-0 text-primary">
              {data.daily.map((day, index) => {
                const height = day.tokens / Math.max(1, ...data.daily.map(d => d.tokens)) * 23;
                return <rect key={day.day} x={index * 160 / data.daily.length} y={24 - height} width={Math.max(1, 160 / data.daily.length - 2)} height={height} fill="currentColor">
                  <title>{day.day}: {number(day.tokens)}</title>
                </rect>;
              })}
            </svg>
          )}
          <span>{t('aiModels.usage.basis', 'Month-to-date pace · {{days}} observed days · {{remaining}} days left', { days: number(forecast?.observedDays), remaining: number(forecast?.remainingDays) })}</span>
          {forecast?.reason === 'INSUFFICIENT_HISTORY' && <span>{t('aiModels.usage.insufficient', 'At least 24 hours of observation are needed for a forecast.')}</span>}
          {forecast?.reason === 'NO_ACTIVITY' && <span>{t('aiModels.usage.noActivity', 'No measured activity yet; no forecast available.')}</span>}
          {!forecast?.reason && forecast?.costUsd == null && <span>{t('aiModels.usage.noCostForecast', 'Cost forecast unavailable: observed usage is not priced.')}</span>}
          <details className="min-w-0 open:basis-full">
            <summary className="w-fit cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('aiModels.usage.method', 'How usage is measured')}</summary>
            <div className="mt-2 max-w-3xl space-y-2 leading-relaxed">
              <p>{t('aiModels.usage.methodHint', 'Tokens include input, output, cache writes and cache reads recorded by the API. MCP and local work are not measured. Calls count recorded API calls and completed media jobs.')}</p>
              <p>{t('aiModels.usage.costHint', 'USD estimates use token list prices and recorded media costs. Unknown charges are excluded. Taxes, exchange rates, Claude subscriptions and hosting are excluded. Billing credits are separate from vendor USD costs. External research charges (Firecrawl / Apify) are unavailable; only native web-search fees are measured.')}</p>
              <p>{t('aiModels.usage.mediaHistoryHint', 'Media totals cover retained READY assets by creation date. Deleting an asset removes it from the estimate; this is not an immutable billing ledger.')}</p>
              <p>{t('aiModels.usage.forecastHint', 'Forecast = actual usage + daily average × remaining calendar days, observed since the later of month start or workspace creation. This historical pace is not an invoice or a prediction of changed settings.')}</p>
              <p>{t('aiModels.usage.mediaHistory', 'Media estimates cover retained completed assets by creation date. Deleting an asset removes its cost from this estimate; this is not an immutable billing ledger.')}</p>
              <p>{t('aiModels.usage.breakdown', 'Recorded calls/jobs: {{calls}} · LLM: {{llm}} · Media: {{media}} · Unpriced calls: {{unpriced}} · Unpriced media: {{jobs}}', { calls: number(data.totals.calls), llm: money(allUnpriced ? null : data.totals.llmCostUsd), media: money(allUnpriced ? null : data.totals.mediaCostUsd), unpriced: number(data.totals.unpricedCalls), jobs: number(data.totals.unpricedMediaJobs) })}</p>
              {data.coverage.untrackedActions.length > 0 && <p>{t('aiModels.usage.untracked', 'Unmeasured actions')}: {data.coverage.untrackedActions.join(', ')}</p>}
              <p>{t('aiModels.usage.updated', 'Updated')}: <time dateTime={data.generatedAt}>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short', timeZone: data.period.timezone }).format(new Date(data.generatedAt))}</time></p>
            </div>
          </details>
        </div>
      </>}
    </section>
  );
}
