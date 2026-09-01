import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Eye,
  Gauge,
  PauseCircle,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';
import { hasMarketingRole, MarketingRole } from '@/features/marketing/types';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';
import {
  getGrowthBudget,
  getWalletState,
  listBudgetActivity,
  listGrowthBudgets,
  type GrowthBudget,
} from '../../../features/marketing/api/growthBudget.service';
import { deriveGrowthMultiple, money, pickLatestObjective } from '../budget/autopilotMath';

/**
 * The Autopilot, compressed into one strip.
 *
 * Until this screen existed, `/studio` WAS the Growth Autopilot console —
 * `<BudgetAutopilotPage embedded />` and nothing else. The new Studio is three
 * panels of actual work, so the engine cannot own the page any more; but an
 * engine that spends real money and can be paused, armed or killed is also the
 * last thing that should become invisible. So it keeps a permanent one-line
 * presence — is it on, how much credit is left, what is this period's cap, is
 * it earning — and its full console is one click away in the tools drawer.
 *
 * Every query here reuses the EXACT key `BudgetAutopilotPage` uses
 * (`['growth-budgets']`, `['growth-wallet']`, `['growth-budget', id]`,
 * `['budget-activity', id]`). That is not an optimisation, it is the whole
 * correctness argument: with a near-miss key the strip and the console would
 * each hold their own copy of the same budget, one of them would go stale after
 * a pause/arm, and the screen would show two different answers to "is it
 * running?" — while silently doubling every request. Sharing the key means
 * opening the drawer costs nothing, and a mutation inside the console
 * invalidates the strip for free.
 */
export interface AutopilotStatusBarProps {
  /**
   * Opens the tools drawer on the Autopilot console. `StudioOneScreen` owns the
   * drawer's open/tool state — it is the thing that reads and writes `?tool=` —
   * so this strip never reaches for the URL itself, it only asks. (The older
   * `?view=tools&tab=…` links are a DIFFERENT surface: `GrowthStudioPage`
   * renders the full-page `ToolsSurface` for those, and nothing maps them onto
   * this drawer.)
   */
  onOpenConsole: () => void;
  className?: string;
}

/**
 * What the strip says out loud, in severity order. The badge is derived rather
 * than read off a single field because no single field answers the question a
 * person is actually asking. `killSwitch` is a separate boolean from `status`,
 * and an ARMED budget with the kill-switch on is stopped — reading
 * `autonomyLevel` alone there would print "Otomatik pilot açık" over an engine
 * that is doing nothing at all, which is precisely the lie a status bar exists
 * to prevent.
 */
type AutopilotState = 'killed' | 'paused' | 'armed' | 'assisted' | 'shadow';

/**
 * `autonomyLevel` has THREE values, not two. Collapsing everything that is not
 * AUTONOMOUS into "Onaylı mod" told a SHADOW workspace that proposals were
 * sitting somewhere waiting for it — but SHADOW is record-only on the backend
 * (`budget-autopilot.service.ts`: "SHADOW → record only (observation mode, no
 * approvals, no writes)"), so no proposal is ever raised and the person waits
 * for a queue that will never fill. That is the same class of lie as printing
 * "Otomatik pilot açık" over a kill-switched budget, which is what the rest of
 * this function exists to prevent, so SHADOW gets its own neutral badge.
 */
function deriveState(budget: GrowthBudget): AutopilotState {
  if (budget.killSwitch || budget.status === 'KILLED') return 'killed';
  if (budget.status === 'PAUSED') return 'paused';
  if (budget.autonomyLevel === 'AUTONOMOUS') return 'armed';
  return budget.autonomyLevel === 'SHADOW' ? 'shadow' : 'assisted';
}

const STATE_TONE: Record<AutopilotState, BadgeProps['tone']> = {
  killed: 'danger',
  paused: 'warning',
  armed: 'success',
  assisted: 'neutral',
  shadow: 'neutral',
};

const STATE_ICON: Record<AutopilotState, ReactNode> = {
  killed: <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />,
  paused: <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />,
  armed: <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />,
  assisted: <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />,
  // An eye, not a spark: nothing is being generated for you to act on.
  shadow: <Eye className="h-3.5 w-3.5" aria-hidden="true" />,
};

export function AutopilotStatusBar({ onOpenConsole, className }: AutopilotStatusBarProps) {
  const { t } = useTranslation('marketing');
  const user = useMarketingAuthStore((s) => s.user);
  /**
   * Reading a budget only needs `reports.read`, so every role can see this
   * strip — but `POST /budget` and `POST /budget/quick-start` are MANAGER-only.
   * A REP offered "Otomatik pilotu kur" would click it, walk through the wizard
   * and collect a 403 at the end, so the setup CTA is gated and replaced with a
   * plain sentence naming who can do it. Nothing is hidden that they could read
   * anyway; only the button that would have lied to them.
   */
  const canManage = hasMarketingRole(user?.role, MarketingRole.MANAGER);

  /**
   * `meta: { silent: true }` — main.tsx installs a global QueryCache.onError
   * that toasts every non-401 failure, and this strip renders its own inline
   * failure line, so without the flag one dead request would both grey out the
   * bar AND throw a toast over the screen. Worth knowing: meta lives on the
   * QUERY, not the observer — query-core re-applies `observer.options` on every
   * fetch — so whichever surface refetched last decides the flag for all of
   * them. That is why `BudgetAutopilotPage` carries the identical `meta` on the
   * same four keys: without it, opening the console in the drawer would silently
   * un-silence the strip's queries and the next failure would toast on top of
   * two inline error states.
   */
  const budgetsQ = useQuery({
    queryKey: ['growth-budgets'],
    queryFn: listGrowthBudgets,
    meta: { silent: true },
  });
  const walletQ = useQuery({
    queryKey: ['growth-wallet'],
    queryFn: getWalletState,
    meta: { silent: true },
  });

  // Most recent period first — the backend orders `periodKey` desc, and the
  // console picks the same row. Picking differently here is how the strip and
  // the console would end up describing two different months.
  const current = budgetsQ.data?.[0];

  const strip = (children: ReactNode) => (
    <Card
      data-testid="autopilot-status-bar"
      className={cn('shrink-0 overflow-hidden', className)}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">{children}</div>
    </Card>
  );

  /**
   * A failed refetch is not the same as an unknown state.
   *
   * React Query keeps `data` and flips `status` to 'error' when a BACKGROUND
   * refetch fails, so a bare `isError` check hands the whole strip to the error
   * line on one flaky poll of `['growth-budgets']` — and the strip is where the
   * "Otomatik pilot konsolu" button lives, i.e. the console (and, through the
   * drawer's menu, every tool behind it) would disappear because a single
   * request timed out. Gate on there being genuinely nothing to show; with a
   * cached budget in hand we keep drawing it and degrade only the FRESHNESS,
   * exactly the way `walletQ.isError` is handled below.
   */
  const staleNote = budgetsQ.isError ? (
    <span className="text-xs text-warning" data-testid="autopilot-stale">
      {t('studio.autopilotBar.stale', 'durum güncellenemedi')}
    </span>
  ) : null;

  if (budgetsQ.isError && budgetsQ.data === undefined) {
    // The one state where dashes would be actively wrong: we do not know
    // whether the engine is armed, so we say that instead of drawing a calm
    // "Onaylı mod" over an unknown.
    return strip(
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-danger">
          {t('studio.autopilotBar.error', 'Otomatik pilot durumu okunamadı.')}
        </span>
        <Button variant="outline" size="sm" onClick={() => budgetsQ.refetch()}>
          {t('common.retry', 'Yeniden dene')}
        </Button>
      </div>,
    );
  }

  if (budgetsQ.isLoading) {
    return strip(
      <>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-28" />
        <Skeleton className="ms-auto h-8 w-40" />
      </>,
    );
  }

  if (!current) {
    /**
     * Nothing has been set up, so there is nothing to report — and a row of
     * "—" for balance, budget and multiple would read as "the engine ran and
     * earned nothing", the opposite of the truth. One sentence, one button.
     */
    return strip(
      <>
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('studio.autopilotBar.title', 'Otomatik pilot')}
        </span>
        <Badge tone="neutral" data-testid="autopilot-state">
          {t('studio.autopilotBar.state.none', 'Kurulmadı')}
        </Badge>
        {staleNote}
        {canManage ? (
          <Button size="sm" className="ms-auto" onClick={onOpenConsole}>
            {t('studio.autopilotBar.setupCta', 'Otomatik pilotu kur')}
          </Button>
        ) : (
          <span className="ms-auto text-sm text-muted-foreground">
            {t(
              'studio.autopilotBar.setupManagerOnly',
              'Kurulumu bir yönetici yapabilir.',
            )}
          </span>
        )}
      </>,
    );
  }

  const state = deriveState(current);
  const stateLabel: Record<AutopilotState, string> = {
    killed: t('studio.autopilotBar.state.killed', 'Acil durdurma açık'),
    paused: t('studio.autopilotBar.state.paused', 'Duraklatıldı'),
    armed: t('studio.autopilotBar.state.armed', 'Otomatik pilot açık'),
    assisted: t('studio.autopilotBar.state.assisted', 'Onaylı mod'),
    shadow: t('studio.autopilotBar.state.shadow', 'Yalnızca gözlem'),
  };

  return strip(
    <>
      <Badge tone={STATE_TONE[state]} data-testid="autopilot-state" className="gap-1.5">
        {STATE_ICON[state]}
        {stateLabel[state]}
      </Badge>
      {staleNote}

      {/* Balance in the WALLET's currency, cap in the BUDGET's — they are two
          independent columns in the API and a workspace can genuinely have a
          TRY wallet against a USD budget. Printing both under one symbol would
          imply a conversion nobody performed, so each carries its own. They are
          never added together here for the same reason. */}
      <Stat
        icon={<Wallet className="h-4 w-4" />}
        label={t('studio.autopilotBar.balance', 'Bakiye')}
        testId="autopilot-balance"
        value={
          // Ordered on HAVING A BALANCE, not on the query's flags, and that
          // order is the correctness argument.
          //
          // A number we hold wins outright: React Query keeps the last good
          // balance and merely flips status on a failed BACKGROUND refetch, so
          // replacing it with "okunamadı" would tell the operator we lost
          // something we did not. Same rule the budget query above uses, and
          // the same one BudgetAutopilotPage's wallet tiles use.
          //
          // Everything else falls through to the skeleton, which is the half
          // that was wrong. `isLoading` is `isPending && isFetching`, so a query
          // that is pending but NOT fetching — the paused state React Query puts
          // an `online` query into when the browser is offline, reachable here
          // because the budget list can be warm in the cache while the wallet is
          // cold — reported neither loading nor error, fell to the last branch,
          // and `money(undefined)` coerced the missing balance to a confident
          // "₺0" over an engine that may have thousands of lira of credit. The
          // one number on this strip that must never be invented is the one that
          // says whether the autopilot can still spend.
          walletQ.data ? (
            money(walletQ.data.balance, walletQ.data.currency ?? current.currency)
          ) : walletQ.isError ? (
            <span className="text-xs font-normal text-warning">
              {t('studio.autopilotBar.balanceUnread', 'okunamadı')}
            </span>
          ) : (
            <Skeleton className="h-4 w-16" />
          )
        }
      />

      <Stat
        icon={<Gauge className="h-4 w-4" />}
        label={t('studio.autopilotBar.budget', 'Bu ayın bütçesi')}
        testId="autopilot-budget"
        value={
          <span className="flex items-baseline gap-1.5">
            {money(current.totalAmount, current.currency)}
            <span className="text-xs font-normal text-muted-foreground">{current.periodKey}</span>
          </span>
        }
      />

      <GrowthMultipleStat budget={current} />

      <Button variant="secondary" size="sm" className="ms-auto" onClick={onOpenConsole}>
        <SlidersHorizontal className="me-1.5 h-4 w-4" aria-hidden="true" />
        {t('studio.autopilotBar.openConsole', 'Otomatik pilot konsolu')}
      </Button>
    </>,
  );
}

/**
 * The hero number, on the strip — but only when it is a number.
 *
 * `deriveGrowthMultiple` reconstructs attributed revenue from the latest run's
 * per-channel avgRoas, and returns `null` the moment either side is
 * unmeasurable (no run signal yet, or nothing spent). The console renders "—"
 * there because it has a labelled StatCard whose absence would itself be a
 * question; on a one-line strip the honest move is to render NOTHING, because
 * "Büyüme katsayısı —" squeezed between two real numbers reads as a measured
 * zero rather than as "we have not measured yet".
 *
 * Its two queries live in this child rather than the parent so the keys are
 * only ever formed with a real budget id — a `['growth-budget', undefined]`
 * entry sitting disabled in the cache is the kind of near-miss key that later
 * gets "fixed" by someone enabling it.
 */
function GrowthMultipleStat({ budget }: { budget: GrowthBudget }) {
  const { t } = useTranslation('marketing');

  // The LIST endpoint does not include allocations (only `GET /budget/:id`
  // does), so the multiple genuinely needs the detail read — the same one the
  // console makes, under the same key, so opening the drawer refetches nothing.
  const detailQ = useQuery({
    queryKey: ['growth-budget', budget.id],
    queryFn: () => getGrowthBudget(budget.id),
    meta: { silent: true },
  });
  const activityQ = useQuery({
    queryKey: ['budget-activity', budget.id],
    queryFn: () => listBudgetActivity(budget.id),
    meta: { silent: true },
  });

  const growth = useMemo(
    () => deriveGrowthMultiple(detailQ.data?.allocations ?? [], pickLatestObjective(activityQ.data)),
    [detailQ.data?.allocations, activityQ.data],
  );

  if (growth.multiple == null) return null;

  return (
    <Stat
      icon={<TrendingUp className="h-4 w-4" />}
      label={t('studio.autopilotBar.multiple', 'Büyüme katsayısı')}
      testId="autopilot-multiple"
      value={`${growth.multiple.toFixed(2)}×`}
    />
  );
}

/** One label/value pair on the strip. Label above value, both on one line's
 *  worth of height — the strip has to survive next to two working panels. */
function Stat({
  icon,
  label,
  value,
  testId,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <span className="text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-micro uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-sm font-medium tabular-nums text-foreground">{value}</span>
      </span>
    </div>
  );
}
