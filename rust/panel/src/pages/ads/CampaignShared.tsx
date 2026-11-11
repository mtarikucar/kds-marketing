import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { isApiError } from '@/api/client';
import type { Campaign, CampaignDetail, Platform } from '@/api/ads';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { formatMoney, formatNumber } from '@/lib/format';

export const isClosed = (c: Campaign) => ['ended', 'expired', 'declined'].includes(c.state.state);
export function platforms(c: Campaign): Platform[] {
  return !c.plan
    ? []
    : c.plan.placements === 'automatic'
      ? ['facebook', 'instagram']
      : c.plan.placements.platforms;
}
export function useAdsKey() {
  return ['ads', useSession().data?.current_workspace] as const;
}
export function useCampaignMutation<T = void>(
  fn: (input: T) => Promise<Campaign>,
  done?: (c: Campaign) => void,
) {
  const client = useQueryClient();
  const key = useAdsKey();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (campaign) => {
      client.setQueryData<CampaignDetail>([...key, 'campaign', campaign.id], (old) =>
        old ? { ...old, campaign } : undefined,
      );
      done?.(campaign);
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({ queryKey: ['budget'] }),
        client.invalidateQueries({ queryKey: ['budget-items'] }),
        client.invalidateQueries({ queryKey: ['work'] }),
        client.invalidateQueries({ queryKey: ['home', 'pending'] }),
      ]);
    },
  });
}
/**
 * The refusals of `jt_app::usecases::ads` a person can act on, by `details.reason`. The three
 * money limits carry what is left under that limit in `details.left`.
 */
const REFUSALS = [
  'no_general_ad_budget',
  'no_paid_lane',
  'spend_stopped',
  'above_general_budget',
  'above_strategy_cap',
  'above_account_cap',
  'already_built',
  'stopped_by_budget',
  'not_running',
  'not_stopped',
  'not_a_proposal',
  'proposal_expired',
] as const;
export function CampaignError({ error, currency }: { error: unknown; currency: string }) {
  const { t, i18n } = useTranslation();
  const reason = isApiError(error) ? REFUSALS.find((r) => r === error.details.reason) : undefined;
  if (isApiError(error) && reason) {
    return (
      <p role="alert" className="text-sm text-danger">
        {t(`adCampaigns.errors.${reason}`, {
          amount:
            typeof error.details.left === 'number'
              ? formatMoney(error.details.left, currency, i18n.language)
              : '—',
        })}
      </p>
    );
  }
  return <ErrorCallout error={error} />;
}
/**
 * What open campaigns still hold of the general ad budget, as the server counts it
 * (`AdCampaign::committed_minor`): a proposal holds nothing, every other open campaign holds
 * what it has not spent yet.
 */
export function heldByCampaigns(campaigns: Campaign[], currency: string) {
  return campaigns
    .filter((c) => c.currency === currency && !isClosed(c) && c.state.state !== 'proposed')
    .reduce((sum, c) => sum + Math.max(0, c.budget_minor - c.totals.spent_minor), 0);
}
/** A campaign's end, when given, is 24 hours to 90 days after its start (the server's rule). */
export function validEnd(start: string, end: string) {
  const run = Date.parse(end) - Date.parse(start);
  return run >= 24 * 60 * 60 * 1000 && run <= 90 * 24 * 60 * 60 * 1000;
}
export function CampaignNumbers({ campaign: c }: { campaign: Campaign }) {
  const { t, i18n } = useTranslation();
  const result = c.totals.results;
  return (
    <dl className="grid min-w-0 gap-3 sm:grid-cols-3">
      <div>
        <dt className="text-xs text-muted-foreground">{t('adCampaigns.spentBudget')}</dt>
        <dd className="text-sm tabular-nums">
          {formatMoney(c.totals.spent_minor, c.currency, i18n.language)} /{' '}
          {formatMoney(c.budget_minor, c.currency, i18n.language)}
          <progress
            aria-label={t('adCampaigns.spentBudget')}
            className="mt-1 block h-1.5 w-full accent-primary"
            value={Math.min(c.totals.spent_minor, c.budget_minor)}
            max={Math.max(1, c.budget_minor)}
          />
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">{t('adCampaigns.results')}</dt>
        <dd>
          {result !== null && c.totals.result_kind
            ? t(`adCampaigns.${c.totals.result_kind}`, { n: formatNumber(result, i18n.language) })
            : t('adCampaigns.unmeasured')}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">{t('adCampaigns.cost')}</dt>
        <dd className="tabular-nums">
          {result !== null && result > 0
            ? formatMoney(c.totals.spent_minor / result, c.currency, i18n.language)
            : '—'}
        </dd>
      </div>
    </dl>
  );
}
/** datetime-local controls use local wall time; the transport always uses RFC3339. */
export function localDateTime(iso: string | null) {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
