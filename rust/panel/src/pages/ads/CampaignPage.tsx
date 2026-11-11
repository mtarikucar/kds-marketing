import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  adPreview,
  getCampaign,
  type AdDay,
  type Campaign,
  type CampaignDetail,
  type Placement,
} from '@/api/ads';
import { QueryState } from '@/components/QueryState';
import { Button } from '@/components/ui';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { MaterialPreview } from '../materials/MaterialsShared';
import { inputClass } from '../StudioShared';
import { CampaignNumbers, isClosed, useAdsKey } from './CampaignShared';
import { CampaignControls } from './CampaignControls';

function AdsPreview({ data }: { data: CampaignDetail }) {
  const { t } = useTranslation();
  const key = useAdsKey();
  const [index, setIndex] = useState(0);
  const [placement, setPlacement] = useState<Placement>('facebook_feed');
  const ad = data.campaign.plan?.ads[index];
  const preview = useQuery({
    queryKey: [...key, 'preview', data.campaign.id, data.campaign.revision, index, placement],
    queryFn: () => adPreview(data.campaign.id, index, placement),
    enabled: Boolean(ad),
    retry: false,
    staleTime: 23 * 60 * 60 * 1000,
  });
  if (!ad)
    return <p>{t(isClosed(data.campaign) ? 'adCampaigns.noPlanClosed' : 'adCampaigns.noPlan')}</p>;
  const material = data.materials.find((m) => ad.material_ids.includes(m.id) && !m.erased_at);
  const built = data.campaign.built?.ads.find((a) => a.index === index);
  return (
    <section className="min-w-0 space-y-4" aria-label={t('adCampaigns.ads')}>
      <div className="flex flex-wrap gap-2">
        {data.campaign.plan?.ads.map((a, i) => (
          <Button
            key={i}
            variant={i === index ? 'secondary' : 'ghost'}
            aria-pressed={i === index}
            className="h-auto min-h-9 whitespace-normal py-2 break-words"
            onClick={() => setIndex(i)}
          >
            {a.name || t('adCampaigns.adNumber', { n: i + 1 })}
          </Button>
        ))}
      </div>
      <label className="block text-sm">
        {t('adCampaigns.placement')}
        <select
          className={`${inputClass} mt-1`}
          value={placement}
          onChange={(e) => setPlacement(e.target.value as Placement)}
        >
          {(['facebook_feed', 'instagram_feed', 'instagram_story', 'instagram_reels'] as const).map((p) => (
            <option key={p} value={p}>
              {t(`adCampaigns.placements.${p}`)}
            </option>
          ))}
        </select>
      </label>
      {preview.data?.html ? (
        <iframe
          title={ad.name || t('adCampaigns.adNumber', { n: index + 1 })}
          srcDoc={preview.data.html}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-[540px] w-full min-w-0 max-w-full rounded-lg border border-border bg-white"
        />
      ) : (
        <article className="mx-auto max-w-lg space-y-3 rounded-lg border border-border bg-surface p-4">
          <p className="text-xs text-muted-foreground" role="status">
            {preview.isLoading ? t('common.loading') : t('adCampaigns.fallback')}
          </p>
          {material && <MaterialPreview material={material} controls />}
          <p className="whitespace-pre-wrap break-words">{ad.primary_text}</p>
          <h3 className="break-words font-medium">{ad.headline}</h3>
          {ad.description && <p className="break-words text-sm">{ad.description}</p>}
          <span className="inline-block rounded border border-border px-3 py-2 text-sm">
            {t(`adCampaigns.cta.${ad.call_to_action}`, { defaultValue: ad.call_to_action })}
          </span>
        </article>
      )}
      {built && (
        <p className="text-sm">
          {ad.name || t('adCampaigns.adNumber', { n: index + 1 })}
          {': '}
          {t(`adCampaigns.adStates.${built.status}`)}
          {built.feedback && <span className="mt-1 block break-words">{built.feedback}</span>}
        </p>
      )}
    </section>
  );
}
function DailyResults({ data }: { data: CampaignDetail }) {
  const { t, i18n } = useTranslation();
  // A day's sum of a number is missing while no ad of the day has that number: never zero.
  const add = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
  const shown = (n: number | null) => (n === null ? '—' : formatNumber(n, i18n.language));
  const days = new Map<string, Omit<AdDay, 'ad'>>();
  for (const day of data.days) {
    const old = days.get(day.day) ?? { day: day.day, spent_minor: null, impressions: null, clicks: null, results: null };
    days.set(day.day, {
      day: day.day,
      spent_minor: add(old.spent_minor, day.spent_minor),
      impressions: add(old.impressions, day.impressions),
      clicks: add(old.clicks, day.clicks),
      results: add(old.results, day.results),
    });
  }
  return (
    <section className="space-y-3">
      <h2 className="font-medium">{t('adCampaigns.days')}</h2>
      {!days.size && <p className="text-sm text-muted-foreground">{t('adCampaigns.noDays')}</p>}
      <ul>
        {[...days.values()]
          .sort((a, b) => a.day.localeCompare(b.day))
          .map((day) => (
            <li key={day.day} className="grid gap-2 border-b border-border py-3 sm:grid-cols-3">
              <time dateTime={day.day}>
                {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
                  new Date(`${day.day}T12:00:00`),
                )}
              </time>
              <p>
                {t('adCampaigns.spent')}:{' '}
                {day.spent_minor === null ? '—' : formatMoney(day.spent_minor, data.campaign.currency, i18n.language)}
              </p>
              <p>
                {data.campaign.totals.result_kind
                  ? t(`adCampaigns.${data.campaign.totals.result_kind}`, {
                      n: shown(day.results),
                    })
                  : `${t('adCampaigns.results')}: ${shown(day.results)}`}
              </p>
              <p className="text-xs text-muted-foreground sm:col-span-3">
                {t('adCampaigns.impressions')}: {shown(day.impressions)} ·{' '}
                {t('adCampaigns.clicks')}: {shown(day.clicks)}
              </p>
            </li>
          ))}
      </ul>
    </section>
  );
}
/**
 * Why the campaign is where it is, in the panel's words: who stopped it and why, why it ended,
 * why the agent could not go on. A person's or an agent's reason and the ad platform's own
 * answer are shown as written; the server's own codes are translated.
 */
function StateNote({ campaign: c }: { campaign: Campaign }) {
  const { t } = useTranslation();
  const state = c.state.state;
  if (state === 'ended' && c.ended)
    return (
      <>
        <p className="text-sm">{t(`adCampaigns.endReasons.${c.ended.reason}`)}</p>
        {c.state.note === 'provider_still_running' && (
          <p className="border-s-2 border-warning bg-warning-subtle p-3 text-sm">
            {t('adCampaigns.notes.provider_still_running')}
          </p>
        )}
      </>
    );
  if (state === 'paused' && c.stop) {
    const code = (['spend_stopped', 'budget_exhausted', 'module_removed', 'workspace_inactive'] as const).find(
      (r) => r === c.stop?.reason,
    );
    return (
      <p className="break-words text-sm">
        {t(`adCampaigns.stoppedBy.${c.stop.by}`)}
        {': '}
        {c.stop.by === 'budget' && code ? t(`adCampaigns.notes.${code}`) : c.stop.reason}
      </p>
    );
  }
  if (!c.state.note) return null;
  return (
    <p className="break-words text-sm">
      {c.state.note === 'plan_refused' ? t('adCampaigns.notes.plan_refused') : c.state.note}
    </p>
  );
}
/** The findings a person can do something about; any other is the agent's to fix. */
const PERSON_FINDINGS = [
  'not_a_usable_ad_account',
  'credential_scope_missing',
  'capability_unavailable',
  'access_expired',
  'account_unreadable',
  'not_the_campaigns_account',
  'currency_mismatch',
  'below_the_accounts_minimum',
  'eu_targeting_needs_payer',
  'lead_form_needs_the_inbox',
  'special_category_not_supported',
] as const;
/** Why the agent's last plan was turned down, while the campaign still has no plan. */
function PlanRefusal({ campaign: c }: { campaign: Campaign }) {
  const { t, i18n } = useTranslation();
  if (c.plan || isClosed(c) || !c.refusal?.length) return null;
  return (
    <section className="space-y-2 border-s-2 border-warning bg-warning-subtle p-3 text-sm">
      <h3 className="font-medium">{t('adCampaigns.refusalTitle', { n: c.refused })}</h3>
      <ul className="list-disc space-y-1 ps-5">
        {c.refusal.map((f, i) => {
          const known = PERSON_FINDINGS.find((r) => r === f.reason);
          return (
            <li key={i} className="break-words">
              {known
                ? t(`adCampaigns.findings.${known}`, {
                    amount:
                      typeof f.least === 'number' ? formatMoney(f.least, c.currency, i18n.language) : '—',
                    account: f.account_currency ?? '—',
                    budget: f.budget_currency ?? '—',
                    needs: f.needs?.join(', ') ?? '—',
                  })
                : t('adCampaigns.findings.other', { field: f.field })}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
export function CampaignPage({ id, manage }: { id: string; manage: boolean }) {
  const { t, i18n } = useTranslation();
  const key = useAdsKey();
  const detail = useQuery({
    queryKey: [...key, 'campaign', id],
    queryFn: () => getCampaign(id),
    refetchInterval: 60_000,
  });
  const data = detail.data;
  const c = data?.campaign;
  return (
    <div className="min-w-0 space-y-5">
      <Link className="text-sm underline" to="/ads">
        {t('adCampaigns.back')}
      </Link>
      <QueryState query={detail} keepOnError>
        {c && data && (
          <>
            <header className="space-y-2">
              <h2 className="break-words font-display text-xl">{c.title || c.goal}</h2>
              {c.title && c.title !== c.goal && <p className="break-words">{c.goal}</p>}
              <p className="text-sm">{t(`adCampaigns.states.${c.state.state}`)}</p>
              <StateNote campaign={c} />
              <p className="text-xs text-muted-foreground">
                {t('adCampaigns.starts', { at: formatDateTime(c.start_at, i18n.language) })}
                {(c.end_at || c.plan?.end_at) &&
                  ` — ${formatDateTime(c.end_at || c.plan?.end_at, i18n.language)}`}
              </p>
            </header>
            {c.state.state === 'proposed' && (
              <p className="border-s-2 border-warning bg-warning-subtle p-3">
                {t('adCampaigns.proposalCost', {
                  amount: formatMoney(c.budget_minor, c.currency, i18n.language),
                })}
              </p>
            )}
            {c.state.state === 'expired' && <p>{t('adCampaigns.expired')}</p>}
            <PlanRefusal campaign={c} />
            <CampaignNumbers campaign={c} />
            <CampaignControls campaign={c} manage={manage} />
            <div className="grid min-w-0 gap-8 xl:grid-cols-2">
              <AdsPreview data={data} />
              <div className="min-w-0 space-y-6">
                {c.plan && (
                  <section className="space-y-2">
                    <h2 className="font-medium">{t('adCampaigns.audience')}</h2>
                    <p className="break-words">{c.plan.audience_summary}</p>
                    <p className="break-words text-sm text-muted-foreground">{c.plan.summary}</p>
                    <h3 className="pt-2 text-sm font-medium">{t('adCampaigns.destination')}</h3>
                    <p className="break-all text-sm">
                      {c.plan.destination.kind === 'website'
                        ? c.plan.destination.url
                        : t('adCampaigns.leadDestination', { name: c.plan.destination.name })}
                    </p>
                  </section>
                )}
                <DailyResults data={data} />
                <p className="text-xs text-muted-foreground">
                  {t('adCampaigns.impressions')}:{' '}
                  {c.totals.impressions === null ? '—' : formatNumber(c.totals.impressions, i18n.language)} ·{' '}
                  {t('adCampaigns.clicks')}:{' '}
                  {c.totals.clicks === null ? '—' : formatNumber(c.totals.clicks, i18n.language)} ·{' '}
                  {t('adCampaigns.ctr')}:{' '}
                  {c.totals.impressions && c.totals.clicks !== null
                    ? `${formatNumber(Math.round((c.totals.clicks / c.totals.impressions) * 10000) / 100, i18n.language)}%`
                    : '—'}
                </p>
              </div>
            </div>
            <section className="space-y-3">
              <h2 className="font-medium">{t('adCampaigns.moves')}</h2>
              {!c.moves.length && <p className="text-sm text-muted-foreground">{t('adCampaigns.noMoves')}</p>}
              <ol className="space-y-4">
                {c.moves.map((move, i) => (
                  <li key={i} className="space-y-1 border-s-2 border-border ps-4">
                    <p className="text-sm">
                      <time dateTime={move.at}>{formatDateTime(move.at, i18n.language)}</time> ·{' '}
                      {t(`adCampaigns.${move.kind}`)}
                      {move.ad !== null && ` · ${t('adCampaigns.adNumber', { n: move.ad + 1 })}`} ·{' '}
                      {t(`adCampaigns.${move.outcome}`)}
                    </p>
                    <p className="break-words">{move.reason}</p>
                    {move.detail && (
                      <p className="break-words text-sm text-muted-foreground">{move.detail}</p>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </QueryState>
    </div>
  );
}
