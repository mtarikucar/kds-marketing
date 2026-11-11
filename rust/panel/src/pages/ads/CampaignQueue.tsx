import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { listCampaigns, type Campaign, type Platform } from '@/api/ads';
import { listBudgetItems } from '@/api/budget';
import { Button } from '@/components/ui';
import { QueryState } from '@/components/QueryState';
import { formatDateTime, formatMoney } from '@/lib/format';
import { inputClass } from '../StudioShared';
import { CampaignNumbers, heldByCampaigns, isClosed, platforms, useAdsKey } from './CampaignShared';
import { OpenCampaignDialog } from './OpenCampaignDialog';

function CampaignRow({ campaign: c }: { campaign: Campaign }) {
  const { t, i18n } = useTranslation();
  return (
    <li className="grid min-w-0 gap-4 border-b border-border py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,.65fr)]">
      <div className="min-w-0 space-y-1">
        <Link
          className="break-words font-medium underline-offset-4 hover:underline"
          to={`/ads?campaign=${encodeURIComponent(c.id)}`}
        >
          {c.title || c.goal}
        </Link>
        <p className="text-xs text-muted-foreground">
          {platforms(c)
            .map((p) => (p === 'facebook' ? 'Facebook' : 'Instagram'))
            .join(', ') || t('adCampaigns.agentChooses')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('adCampaigns.starts', { at: formatDateTime(c.start_at, i18n.language) })}
        </p>
      </div>
      <CampaignNumbers campaign={c} />
      <p className="text-sm">{t(`adCampaigns.states.${c.state.state}`)}</p>
    </li>
  );
}
export function CampaignQueue({ manage }: { manage: boolean }) {
  const { t, i18n } = useTranslation();
  const key = useAdsKey();
  const [platform, setPlatform] = useState<Platform | ''>('');
  const [creating, setCreating] = useState(false);
  const [closedVisible, setClosedVisible] = useState(false);
  const budget = useQuery({ queryKey: ['budget-items', key[1]], queryFn: listBudgetItems });
  const general = budget.data?.find(
    (b) =>
      b.item.general &&
      b.item.kind === 'ad_budget' &&
      !b.item.retired_at &&
      b.item.unit.kind === 'currency' &&
      b.item.period !== 'total',
  );
  const open = useInfiniteQuery({
    queryKey: [...key, 'list', 'open'],
    queryFn: ({ pageParam }) => listCampaigns('open', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
    refetchInterval: 60_000,
  });
  const closed = useInfiniteQuery({
    queryKey: [...key, 'list', 'closed'],
    queryFn: ({ pageParam }) => listCampaigns('closed', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
    enabled: closedVisible,
  });
  const rows = (items: Campaign[]) =>
    [...new Map(items.map((c) => [c.id, c])).values()].filter(
      (c) => !platform || platforms(c).includes(platform),
    );
  const allOpen = open.data?.pages.flatMap((p) => p.campaigns).filter((c) => !isClosed(c)) ?? [];
  // Open campaigns by their start; closed ones as the server gives them, newest first.
  const openRows = rows(allOpen).sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const closedRows = rows(closed.data?.pages.flatMap((p) => p.campaigns).filter(isClosed) ?? []);
  const currency = general?.item.unit.kind === 'currency' ? general.item.unit.value : '';
  const held = heldByCampaigns(allOpen, currency);
  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="text-sm">
          {t('adCampaigns.platform')}
          <select
            className={`${inputClass} mt-1`}
            value={platform}
            onChange={(e) => setPlatform(e.target.value as Platform | '')}
          >
            <option value="">{t('adCampaigns.allPlatforms')}</option>
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
          </select>
        </label>
        {manage && <Button onClick={() => setCreating(true)}>{t('adCampaigns.open')}</Button>}
      </div>
      <QueryState query={budget}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border bg-surface-muted px-3 py-3 text-sm">
          {general && general.item.unit.kind === 'currency' ? (
            <p>
              {t('adCampaigns.general')} · {t(`budget.periods.${general.item.period}`)} ·{' '}
              {t('adCampaigns.allPlatforms')}
              <span className="mt-1 block tabular-nums">
                {formatMoney(general.spent_in_period, general.item.unit.value, i18n.language)} /{' '}
                {formatMoney(general.item.cap, general.item.unit.value, i18n.language)}
              </span>
              {held > 0 && (
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t('adCampaigns.heldByCampaigns', {
                    amount: formatMoney(held, general.item.unit.value, i18n.language),
                  })}
                </span>
              )}
            </p>
          ) : (
            <p>{t('adCampaigns.noBudget')}</p>
          )}
          <Link className="underline" to="/budget">
            {t('adCampaigns.viewBudget')}
          </Link>
        </div>
      </QueryState>
      <QueryState query={open} keepOnError>
        <ul aria-label={t('adCampaigns.queue')}>
          {openRows.map((c) => (
            <CampaignRow key={c.id} campaign={c} />
          ))}
        </ul>
        {!openRows.length && (
          <p className="text-sm text-muted-foreground">
            {t(platform ? 'adCampaigns.noMatch' : 'adCampaigns.empty')}
          </p>
        )}
        {open.hasNextPage && (
          <Button
            variant="outline"
            loading={open.isFetchingNextPage}
            onClick={() => void open.fetchNextPage()}
          >
            {t('adCampaigns.more')}
          </Button>
        )}
      </QueryState>
      {!closedVisible ? (
        <Button variant="ghost" onClick={() => setClosedVisible(true)}>
          {t('adCampaigns.showClosed')}
        </Button>
      ) : (
        <section className="space-y-3">
          <h2 className="font-medium">{t('adCampaigns.closed')}</h2>
          <QueryState query={closed} keepOnError>
            <ul aria-label={t('adCampaigns.closed')}>
              {closedRows.map((c) => (
                <CampaignRow key={c.id} campaign={c} />
              ))}
            </ul>
            {closed.hasNextPage && (
              <Button
                variant="outline"
                loading={closed.isFetchingNextPage}
                onClick={() => void closed.fetchNextPage()}
              >
                {t('adCampaigns.more')}
              </Button>
            )}
          </QueryState>
        </section>
      )}
      {creating && (
        <OpenCampaignDialog general={general} held={held} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}
