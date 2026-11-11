import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listCampaigns, listTemplates, outreachReport } from '@/api/outreach';
import { getPoolSettings, prospectsReport } from '@/api/prospects';
import {
  PROSPECTS_REPORT_GROUPS,
  type OutreachReportGroup,
  type OutreachReportRow,
  type ProspectsReportGroup,
  type ProspectsReportRow,
} from '@/api/types';
import { QueryState } from '@/components/QueryState';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, PageHeader } from '@/components/ui';
import { formatMoney } from '@/lib/format';
import { addDays, dayRange, localToday } from '@/lib/localDay';
import { selectClass } from './InboxShared';
import { useLeadsKey } from './LeadsShared';

// The two reports (spec 2026-10-30-leads-pool-outreach-design.md §3.16, §9): the pool's funnel
// and outreach's sends, over whole local days of the workspace's zone sent as `[from, to)`
// instants. Revenue is listed per currency, never added across currencies.

/** The workspace's zone the days are counted in (the pool's settings carry it). */
function useReportZone() {
  const key = useLeadsKey();
  const settings = useQuery({ queryKey: [...key, 'prospects', 'settings'], queryFn: getPoolSettings });
  return settings.data?.timezone ?? (settings.isError ? 'UTC' : undefined);
}

/** A range of local days, the last 30 unless chosen; its instants follow the zone. */
function useDayRange(tz: string | undefined) {
  const [days, setDays] = useState<{ first: string; last: string } | null>(null);
  const today = tz ? localToday(tz) : '';
  const chosen = days ?? { first: today ? addDays(today, -29) : '', last: today };
  const valid = !!tz && !!chosen.first && !!chosen.last && chosen.first <= chosen.last;
  return {
    chosen,
    set: (patch: Partial<{ first: string; last: string }>) => setDays({ ...chosen, ...patch }),
    range: valid ? dayRange(chosen.first, chosen.last, tz!) : null,
  };
}

function RangeFields({ range, tz }: { range: ReturnType<typeof useDayRange>; tz: string | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        {t('leads.report.fromDay')}
        <Input type="date" value={range.chosen.first} onChange={(e) => range.set({ first: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t('leads.report.toDay')}
        <Input type="date" value={range.chosen.last} onChange={(e) => range.set({ last: e.target.value })} />
      </label>
      {tz && <p className="pb-2 text-caption text-muted-foreground">{t('leads.report.zone', { tz })}</p>}
    </div>
  );
}

const percent = (v: number | null) => (v === null ? '—' : `%${Math.round(v * 100)}`);
const total = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

/** Revenue per currency, one line each, never summed across currencies. */
function Revenue({ byCurrency }: { byCurrency: Record<string, number> }) {
  const { i18n } = useTranslation();
  const entries = Object.entries(byCurrency).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return <span>—</span>;
  return (
    <ul data-testid="revenue" className="flex flex-col">
      {entries.map(([currency, minor]) => (
        <li key={currency} className="whitespace-nowrap tabular-nums">
          {formatMoney(minor, currency, i18n.language)}
        </li>
      ))}
    </ul>
  );
}

function poolKeyText(t: TFunction, group: ProspectsReportGroup, key: string | null): string {
  if (key === null) return t('leads.report.none');
  if (group === 'source' && ['research_task', 'manual', 'agent', 'v1_import', 'system'].includes(key)) {
    return t(`leads.originVia.${key as 'research_task' | 'manual' | 'agent' | 'v1_import' | 'system'}`);
  }
  return group === 'rubric_digest' ? key.slice(0, 12) : key;
}

/** The pool's funnel by the chosen grouping. */
function PoolReport({ range }: { range: { from: string; to: string } | null }) {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const [groupBy, setGroupBy] = useState<ProspectsReportGroup>('source');
  const report = useQuery({
    queryKey: [...key, 'prospects', 'report', range, groupBy],
    queryFn: () => prospectsReport({ ...range!, group_by: groupBy }),
    enabled: range !== null,
    placeholderData: keepPreviousData,
  });
  const cols = ['created', 'scored', 'qualified', 'rejected', 'promoted', 'contacted', 'replied', 'meetings', 'quoted', 'won', 'lost'] as const;
  const cell = (g: ProspectsReportRow, c: (typeof cols)[number]) =>
    c === 'rejected' || c === 'lost' ? total(g[c]) : g[c];
  return (
    <section aria-label={t('leads.report.pool.title')} className="flex flex-col gap-3">
      <label className="flex max-w-xs flex-col gap-1 text-sm">
        {t('leads.report.groupBy')}
        <select className={selectClass} value={groupBy} onChange={(e) => setGroupBy(e.target.value as ProspectsReportGroup)}>
          {PROSPECTS_REPORT_GROUPS.map((g) => (
            <option key={g} value={g}>
              {t(`leads.report.pool.groups.${g}`)}
            </option>
          ))}
        </select>
      </label>
      <QueryState query={report}>
        {report.data && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-caption text-muted-foreground">
                <tr>
                  <th className="py-1 pe-3 font-normal">{t('leads.report.group')}</th>
                  {cols.map((c) => (
                    <th key={c} className="py-1 pe-3 font-normal">
                      {t(`leads.report.pool.cols.${c}`)}
                    </th>
                  ))}
                  <th className="py-1 pe-3 font-normal">{t('leads.report.pool.cols.revenue')}</th>
                  <th className="py-1 font-normal">{t('leads.report.pool.cols.rates')}</th>
                </tr>
              </thead>
              <tbody>
                {report.data.groups.map((g) => (
                  <tr key={g.key ?? ''} className="border-t border-border align-top">
                    <td className="py-2 pe-3 font-medium">{poolKeyText(t, report.data!.group_by, g.key)}</td>
                    {cols.map((c) => (
                      <td key={c} className="py-2 pe-3 tabular-nums">
                        {cell(g, c)}
                      </td>
                    ))}
                    <td className="py-2 pe-3">
                      <Revenue byCurrency={g.won_revenue} />
                    </td>
                    <td className="py-2 text-caption">
                      {t('leads.report.pool.ratesText', {
                        replied: percent(g.rates.promoted_to_replied),
                        meeting: percent(g.rates.replied_to_meeting),
                        won: percent(g.rates.meeting_to_won),
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report.data.groups.length === 0 && <p className="text-sm text-muted-foreground">{t('leads.report.empty')}</p>}
            {report.data.truncated && <p className="text-sm text-muted-foreground">{t('leads.report.truncated')}</p>}
          </div>
        )}
      </QueryState>
    </section>
  );
}

/** Outreach's sends by campaign, step or template; of one campaign when `campaignId` is given. */
export function OutreachReport({
  range,
  campaignId,
}: {
  range: { from: string; to: string } | null;
  campaignId?: string;
}) {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const [groupBy, setGroupBy] = useState<OutreachReportGroup>(campaignId ? 'step' : 'campaign');
  const report = useQuery({
    queryKey: [...key, 'outreach', 'report', campaignId ?? 'all', range, groupBy],
    queryFn: () => outreachReport({ ...range!, campaign_id: campaignId, group_by: groupBy }),
    enabled: range !== null,
    placeholderData: keepPreviousData,
  });
  const campaigns = useQuery({ queryKey: [...key, 'outreach', 'campaigns', 'all'], queryFn: () => listCampaigns() });
  const templates = useQuery({ queryKey: [...key, 'outreach', 'templates', true], queryFn: () => listTemplates({ include_archived: true }) });
  const label = (g: OutreachReportRow): string => {
    const campaign = campaigns.data?.items.find((c) => c.id === g.campaign_id)?.name;
    const tpl = templates.data?.items.find((x) => x.template.id === g.template_id)?.template.name;
    if (groupBy === 'template') return tpl ?? t('leads.report.outreach.unknownTemplate');
    if (groupBy === 'step') {
      const step = t('leads.report.outreach.step', { n: g.step ?? 1 });
      return campaignId ? step : `${campaign ?? '—'} · ${step}`;
    }
    return campaign ?? t('leads.report.outreach.unknownCampaign');
  };
  const cols = ['enrolled', 'skipped', 'sent', 'failed', 'bounced', 'complained', 'replied', 'unsubscribed', 'unique_clicks', 'meetings_30d', 'won_30d', 'stopped'] as const;
  const cell = (g: OutreachReportRow, c: (typeof cols)[number]) => {
    if (c === 'skipped' || c === 'stopped') return total(g[c]);
    if (c === 'unique_clicks') return g.unique_clicks ?? '—';
    if (c === 'replied') return t('leads.report.outreach.repliedText', { n: g.replied, threaded: g.replied_threaded });
    return g[c];
  };
  return (
    <section aria-label={t('leads.report.outreach.title')} className="flex flex-col gap-3">
      <label className="flex max-w-xs flex-col gap-1 text-sm">
        {t('leads.report.groupBy')}
        <select className={selectClass} value={groupBy} onChange={(e) => setGroupBy(e.target.value as OutreachReportGroup)}>
          {(['campaign', 'step', 'template'] as const)
            .filter((g) => !(campaignId && g === 'campaign'))
            .map((g) => (
              <option key={g} value={g}>
                {t(`leads.report.outreach.groups.${g}`)}
              </option>
            ))}
        </select>
      </label>
      <QueryState query={report}>
        {report.data && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-caption text-muted-foreground">
                <tr>
                  <th className="py-1 pe-3 font-normal">{t('leads.report.group')}</th>
                  {cols.map((c) => (
                    <th key={c} className="py-1 pe-3 font-normal">
                      {t(`leads.report.outreach.cols.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.data.groups.map((g, i) => (
                  <tr key={`${g.campaign_id}:${g.step}:${g.template_id}:${i}`} className="border-t border-border">
                    <td className="py-2 pe-3 font-medium">{label(g)}</td>
                    {cols.map((c) => (
                      <td key={c} className="py-2 pe-3 tabular-nums">
                        {cell(g, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {report.data.groups.length === 0 && <p className="text-sm text-muted-foreground">{t('leads.report.empty')}</p>}
            {report.data.truncated && <p className="text-sm text-muted-foreground">{t('leads.report.truncated')}</p>}
          </div>
        )}
      </QueryState>
    </section>
  );
}

/** A campaign's report, with its own range (the campaign page's report tab). */
export function CampaignReport({ campaignId }: { campaignId: string }) {
  const tz = useReportZone();
  const range = useDayRange(tz);
  return (
    <div className="flex flex-col gap-3">
      <RangeFields range={range} tz={tz} />
      <OutreachReport range={range.range} campaignId={campaignId} />
    </div>
  );
}

/** `/prospects/report`: the pool's and outreach's reports over local days (spec §9). */
export function LeadsReport() {
  const { t } = useTranslation();
  const tz = useReportZone();
  const range = useDayRange(tz);
  return (
    <>
      <PageHeader
        title={t('leads.report.title')}
        description={t('leads.report.description')}
        actions={
          <Button asChild variant="outline">
            <Link to="/prospects">{t('leads.prospects.title')}</Link>
          </Button>
        }
      />
      <RangeFields range={range} tz={tz} />
      <Card>
        <CardHeader>
          <CardTitle>{t('leads.report.pool.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <PoolReport range={range.range} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('leads.report.outreach.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <OutreachReport range={range.range} />
        </CardContent>
      </Card>
    </>
  );
}
