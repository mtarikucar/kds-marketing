import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  budgetBreakdown,
  stopSpending,
  SPENDING_MODULES,
  type Breakdown,
  type ItemBreakdown,
  type Stop,
} from '@/api/budget';
import type { Unit } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Button, Input } from '@/components/ui';
import { formatAmount } from '@/lib/budget';
import { canAny } from '@/lib/roles';

function dateInput(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function useBudgetBreakdown() {
  const session = useSession();
  const [from, setFrom] = useState(() => {
    const now = new Date();
    return dateInput(new Date(now.getFullYear(), now.getMonth(), 1));
  });
  const [until, setUntil] = useState(() => {
    const now = new Date();
    return dateInput(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  });
  const allowed = canAny(session.data, [
    'budget.manage',
    ...SPENDING_MODULES.map((m) => `${m}.work` as const),
  ]);
  const valid = Boolean(from && until && from < until);
  const query = useQuery({
    queryKey: ['budget', 'breakdown', session.data?.current_workspace, from, until],
    queryFn: () =>
      budgetBreakdown(
        new Date(`${from}T00:00:00`).toISOString(),
        new Date(`${until}T00:00:00`).toISOString(),
      ),
    enabled: allowed && valid,
    refetchInterval: 60_000,
  });
  return { from, setFrom, until, setUntil, valid, allowed, query };
}
export function BreakdownPeriod({ view }: { view: ReturnType<typeof useBudgetBreakdown> }) {
  const { t } = useTranslation();
  if (!view.allowed) return null;
  return (
    <section className="space-y-3">
      <h2 className="font-medium">{t('budgetSpending.breakdown')}</h2>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-0 text-sm">
          {t('budgetSpending.from')}
          <Input
            className="mt-1 min-w-0 max-w-full"
            type="date"
            value={view.from}
            onChange={(e) => view.setFrom(e.target.value)}
          />
        </label>
        <label className="min-w-0 text-sm">
          {t('budgetSpending.until')}
          <Input
            className="mt-1 min-w-0 max-w-full"
            type="date"
            value={view.until}
            onChange={(e) => view.setUntil(e.target.value)}
          />
        </label>
      </div>
      {!view.valid ? (
        <p role="alert">{t('budgetSpending.invalidPeriod')}</p>
      ) : (
        <QueryState query={view.query} />
      )}
    </section>
  );
}
export function ItemSpending({ item, unit }: { item: ItemBreakdown | undefined; unit: Unit }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="max-w-[calc(100vw-4rem)] space-y-2 text-sm md:max-w-none">
      {!!item?.held_minor && (
        <p className="flex flex-wrap justify-between gap-2">
          <span>{t('budgetSpending.held')}</span>
          <span className="tabular-nums">{formatAmount(t, item.held_minor, unit, i18n.language)}</span>
        </p>
      )}
      <h3 className="font-medium">{t('budgetSpending.breakdown')}</h3>
      {!item?.modules.length && !item?.unattributed_minor ? (
        <p className="text-muted-foreground">{t('budgetSpending.noSpend')}</p>
      ) : (
        <ul className="space-y-2">
          {item.modules.map((module) => (
            <li key={module.module}>
              <div className="flex flex-wrap justify-between gap-2">
                <span>{t(`budgetSpending.modules.${module.module}`)}</span>
                <span className="tabular-nums">
                  {formatAmount(t, module.spent_minor, unit, i18n.language)}
                </span>
              </div>
              <ul className="mt-1 space-y-1 border-s border-border ps-4">
                {module.campaigns.map((c) => (
                  <li className="flex flex-wrap justify-between gap-2" key={c.campaign_id}>
                    <Link
                      className="break-words underline"
                      to={`/ads?campaign=${encodeURIComponent(c.campaign_id)}`}
                    >
                      {c.title}
                    </Link>
                    <span className="tabular-nums">
                      {formatAmount(t, c.spent_minor, unit, i18n.language)}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {!!item.unattributed_minor && (
            <li className="flex flex-wrap justify-between gap-2">
              <span>{t('budgetSpending.byHand')}</span>
              <span className="tabular-nums">
                {formatAmount(t, item.unattributed_minor, unit, i18n.language)}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
export function SpendingStops({ stop, manage }: { stop: Stop; manage: boolean }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const workspace = useSession().data?.current_workspace;
  const mutation = useMutation({
    mutationFn: stopSpending,
    onSuccess: (next) => {
      client.setQueriesData<Breakdown>({ queryKey: ['budget', 'breakdown', workspace] }, (old) =>
        old ? { ...old, stop: next } : undefined,
      );
      void client.invalidateQueries({ queryKey: ['ads', workspace] });
    },
  });
  return (
    <section
      aria-label={t('budgetSpending.stopping')}
      className="mt-6 min-w-0 space-y-4 border-t border-border pt-6"
    >
      <h2 className="font-medium">{t('budgetSpending.stopping')}</h2>
      <p className="text-sm text-muted-foreground">{t('budgetSpending.help')}</p>
      <ErrorCallout error={mutation.error} />
      {(['all', ...SPENDING_MODULES] as const).map((module) => {
        const direct = module === 'all' ? stop.all : stop.modules.includes(module);
        const effective = stop.all || direct;
        // Only what is stopped can be waiting for its pause at a provider.
        const waiting =
          effective &&
          stop.paused.some((p) => (module === 'all' || p.module === module) && p.state === 'pausing');
        const state = waiting ? 'waiting' : effective ? 'stopped' : 'running';
        const scope = module === 'all' ? t('budgetSpending.all') : t(`budgetSpending.modules.${module}`);
        return (
          <div
            key={module}
            className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border pb-3"
          >
            <div>
              <p className="text-sm font-medium">{scope}</p>
              <p className="text-sm text-muted-foreground">{t(`budgetSpending.${state}`)}</p>
            </div>
            {manage && (
              <Button
                variant="outline"
                className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-start"
                disabled={mutation.isPending || (module !== 'all' && stop.all)}
                aria-label={
                  effective
                    ? t('budgetSpending.resumeScope', { scope })
                    : module === 'all'
                      ? undefined
                      : t('budgetSpending.stopModule', { module: scope })
                }
                onClick={() =>
                  mutation.mutate({
                    scope: module === 'all' ? 'all' : { module },
                    stopped: !direct,
                    expected_revision: stop.revision,
                  })
                }
              >
                {effective
                  ? t('budgetSpending.resume')
                  : module === 'all'
                    ? t('budgetSpending.stopAll')
                    : t('budgetSpending.stop')}
              </Button>
            )}
          </div>
        );
      })}
      <ul className="space-y-2">
        {stop.paused.map((p, i) => (
          <li key={i} className="flex flex-wrap justify-between gap-2 text-sm">
            <span className="break-words">{p.title}</span>
            <span>{t(p.state === 'pausing' ? 'budgetSpending.waiting' : 'budgetSpending.stopped')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
