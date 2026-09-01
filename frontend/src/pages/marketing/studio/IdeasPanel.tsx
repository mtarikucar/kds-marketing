import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Compass, Lightbulb, Plug, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/Tooltip';
import {
  approveAction,
  dismissAction,
  getStrategy,
  listStrategyActions,
  refreshStrategy,
  type StrategyAction,
} from '../../../features/marketing/api/strategy.service';
import { hasMarketingRole, MarketingRole } from '../../../features/marketing/types';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { actionKindMeta, priorityMeta, resultRefLabel } from './actionKinds';

/**
 * The Growth Studio's left-bottom panel: campaign IDEAS, and — for each one —
 * what approving it will actually do.
 *
 * THERE IS NO "IDEA" ENTITY IN THIS PRODUCT, AND THAT IS THE POINT. The owner
 * asked for "kampanya fikirleri ve bu kampanya fikirleri için neler yapılması
 * gerekiyor, stratejiye bağlı bir bölüm", and a new Idea table would have been
 * the wrong answer twice over: it would be a second, weaker copy of something
 * that already exists, and it would be inert — a list of suggestions nobody can
 * act on without leaving the screen. A `StrategyAction` at status PROPOSED is
 * already all three things at once: the idea (title), the argument for it
 * (rationale), and an executor-ready payload the orchestrator can run the
 * moment a human says yes. So this panel is a view onto that queue, sharing
 * StrategyConsolePage's exact query keys — the two surfaces read one cache and
 * therefore cannot disagree about what is proposed.
 *
 * WHAT THIS PANEL IS NOT. It is not a second strategy console. The full
 * console (autonomy lane, identity, per-channel fit bars, community channel
 * connection) stays at /studio/strategy and is linked from the footer.
 * Duplicating it here would put two editable copies of the same governance
 * controls on two screens, which is how a workspace ends up with an autonomy
 * lane nobody remembers arming.
 *
 * THE HONESTY REQUIREMENT. Every card carries a "Bu ne yapacak?" line that was
 * checked against the executor it describes (see actionKinds.ts, which holds
 * the copy and the affordance in ONE row so they cannot drift apart). Two of
 * those executors publish or spend, so their approve button sits behind a
 * confirm that names the cost; one kind has no executor at all, so it gets no
 * approve button — only a route to the page where the work is done by hand.
 */
export default function IdeasPanel() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();

  /**
   * READS vs DECISIONS have different backend gates, and conflating them is
   * what turns this panel into a wall of red toasts for a REP.
   *
   * GET /strategy and GET /strategy/actions need only `reports.read`, so both
   * queries run for everybody — a rep should be able to SEE what the strategist
   * proposed. Approve / dismiss / refresh are `@MarketingRoles('MANAGER')` plus
   * `settings.manage`, so those affordances are withheld and replaced by one
   * quiet line. Rendering the buttons anyway and letting the 403 explain it is
   * the pattern this codebase has already paid for.
   */
  const user = useMarketingAuthStore((s) => s.user);
  const canDecide = hasMarketingRole(user?.role, MarketingRole.MANAGER);

  /**
   * `meta: { silent: true }` on both queries: main.tsx installs a global
   * QueryCache.onError that toasts every non-401 failure, and this panel draws
   * its own error state through QueryStateBoundary. Without the opt-out a
   * failed load reports itself twice — once inline and once as a toast that
   * says the same thing with less context.
   */
  const strategyQuery = useQuery({
    queryKey: ['marketing', 'strategy'],
    queryFn: getStrategy,
    meta: { silent: true },
  });

  /**
   * GET /strategy returns 200 with a NULL BODY when the workspace has never
   * been through onboarding — it is `findUnique`, not a 404. So "no strategy"
   * is a successful query with `data === null`, and any code that waits for an
   * error to detect it waits forever.
   */
  const strategy = strategyQuery.data ?? null;

  const actionsQuery = useQuery({
    queryKey: ['marketing', 'strategy', 'actions', 'PROPOSED'],
    queryFn: () => listStrategyActions('PROPOSED'),
    enabled: !!strategy,
    meta: { silent: true },
  });

  /**
   * The action whose approval is waiting on a confirm. Held as the whole row,
   * not just its id, so the dialog can name the idea in its own words — a
   * confirm that says "Emin misin?" about an unnamed thing is a confirm people
   * learn to click through.
   */
  const [confirming, setConfirming] = useState<StrategyAction | null>(null);
  const [refreshOpen, setRefreshOpen] = useState(false);

  /**
   * The outcome of the last approval, when it FAILED.
   *
   * This is not decoration; it is the only way the operator learns what
   * happened. See `approve` below for why the mutation's own response cannot be
   * trusted, and why a toast alone is not enough (a toast that vanishes after
   * four seconds is a fine confirmation and a terrible error report).
   */
  const [failure, setFailure] = useState<{ id: string; title: string; message: string } | null>(
    null,
  );

  const invalidateProposed = () =>
    qc.invalidateQueries({ queryKey: ['marketing', 'strategy', 'actions', 'PROPOSED'] });

  /**
   * APPROVE — and the two things about it that are easy to get wrong.
   *
   * (1) THE RESPONSE IS A PRE-EXECUTION SNAPSHOT. `StrategyService.approveAction`
   * flips PROPOSED→APPROVED, captures the updated row, THEN awaits the
   * orchestrator, and finally returns the row it captured BEFORE any of that
   * ran. So the payload always says `status: 'APPROVED', resultRef: null`, even
   * for an action that has already blown up — rendering it as the final state
   * would report every failure in the product as a success. We therefore ignore
   * the returned row entirely and go and ask what actually happened.
   *
   * (2) BECAUSE THE SERVER AWAITS THE ORCHESTRATOR, the action IS terminal by
   * the time this promise resolves: DONE or FAILED (the only kind that stays
   * APPROVED is one with no executor, and that kind has no approve button — see
   * actionKinds.ts). That is what makes the probe below sound: one read of the
   * FAILED list right after the response either finds our id or proves the run
   * succeeded. Doing it the other way round — refetching only PROPOSED — tells
   * us the row left the queue, which is equally true of a failure.
   *
   * The probe is best-effort: if it throws, we still invalidate and say plainly
   * that we could not confirm the outcome, rather than claiming success.
   */
  const approve = useMutation({
    mutationFn: (id: string) => approveAction(id),
    onSuccess: async (_preExecutionSnapshot, id) => {
      const approved = (actionsQuery.data ?? []).find((a) => a.id === id);
      const title = approved?.title ?? '';

      let failed: StrategyAction | undefined;
      let probed = true;
      try {
        const failedRows = await qc.fetchQuery({
          queryKey: ['marketing', 'strategy', 'actions', 'FAILED'],
          queryFn: () => listStrategyActions('FAILED'),
          // Force a real read: the global default staleTime is 30s, and a
          // cached FAILED list from a minute ago cannot contain the run that
          // finished two seconds ago.
          staleTime: 0,
          meta: { silent: true },
        });
        failed = failedRows.find((a) => a.id === id);
      } catch {
        probed = false;
      }

      await invalidateProposed();

      if (failed) {
        const parsed = resultRefLabel(failed.resultRef);
        // `resultRef` is where a failure's message rides (there is no error
        // column), so it is the reason — unless the row somehow has none.
        const message =
          parsed && parsed.failed
            ? parsed.message
            : t('strategy.ideas.failureUnknown', 'sebep kaydedilmemiş');
        setFailure({ id, title: failed.title || title, message });
        toast.error(
          t('strategy.ideas.toastFailed', '«{{title}}» çalıştırılamadı', {
            title: failed.title || title,
          }),
        );
        return;
      }

      // Clear a stale failure banner for THIS row only — another row's earlier
      // failure is still true and must not be swept away by an unrelated win.
      setFailure((f) => (f?.id === id ? null : f));
      toast[probed ? 'success' : 'info'](
        probed
          ? t('strategy.ideas.toastApproved', '«{{title}}» onaylandı ve çalıştırıldı', { title })
          : t(
              'strategy.ideas.toastApprovedUnverified',
              '«{{title}}» onaylandı — sonucunu doğrulayamadık, strateji konsolundan bakabilirsin',
              { title },
            ),
      );
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ??
          t('strategy.ideas.approveFailed', 'Fikir onaylanamadı'),
      ),
    // The confirm stays open for the whole (slow) round trip so its button can
    // carry the spinner; it closes once we know something, success or not.
    onSettled: () => setConfirming(null),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissAction(id),
    onSuccess: (_row, id) => {
      setFailure((f) => (f?.id === id ? null : f));
      invalidateProposed();
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ?? t('strategy.ideas.dismissFailed', 'Fikir yoksayılamadı'),
      ),
  });

  /**
   * REFRESH — destructive and expensive, which is why it is only ever reached
   * through the ConfirmDialog below and never from a bare button.
   *
   * Server-side, synthesis's persist() runs `strategyAction.deleteMany` with NO
   * status filter before inserting the new plan: every action goes, DONE and
   * FAILED ones included, and with them the `resultRef`s that are the only link
   * from an idea to the draft post / research run / campaign shell it produced.
   * On top of that it is a bounded multi-turn Opus loop billed per turn, plus
   * live crawl spend, none of which is refunded if it dies halfway.
   */
  const refresh = useMutation({
    mutationFn: () => refreshStrategy(),
    onSuccess: async (res) => {
      // The client type only promises `actionCount`; the server also returns a
      // `skipped` reason when the workspace has no ACTIVE strategy or no intake
      // session to re-synthesize from. Reading it here keeps a truthful no-op
      // from being reported as a fresh plan.
      const r = (res ?? {}) as { actionCount?: number; skipped?: string | boolean };
      setFailure(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['marketing', 'strategy'] }),
        invalidateProposed(),
      ]);
      if (r.skipped) {
        toast.info(
          t(
            'strategy.ideas.refreshSkipped',
            'Yeniden üretilecek bir şey bulunamadı — önce strateji kurulumunu tamamla.',
          ),
        );
        return;
      }
      toast.success(
        t('strategy.ideas.refreshDone', 'Yeni plan hazır: {{count}} fikir', {
          count: r.actionCount ?? 0,
        }),
      );
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ?? t('strategy.ideas.refreshFailed', 'Fikirler yenilenemedi'),
      ),
    onSettled: () => setRefreshOpen(false),
  });

  /**
   * The backend already returns the plan sorted HIGH→MEDIUM→LOW and then oldest
   * first. This deliberately does NOT re-sort it: a second sort with a
   * different tiebreak is exactly how this panel and the strategy console would
   * end up naming different ideas as "next" while reading the same cache.
   */
  const actions = actionsQuery.data ?? [];
  const brief = strategy?.brief ?? null;

  const openApprove = (a: StrategyAction) => {
    if (actionKindMeta(a.kind).affordance === 'APPROVE_CONFIRM') {
      setConfirming(a);
      return;
    }
    approve.mutate(a.id);
  };

  const confirmingMeta = confirming ? actionKindMeta(confirming.kind) : null;
  const confirmingBusy = approve.isPending && approve.variables === confirming?.id;

  return (
    // Radix tooltips need a provider in the tree and there is none at the app
    // root; the CHANNEL_SETUP row's explanation hangs off one.
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col" data-testid="ideas-panel">
        <QueryStateBoundary
          isLoading={strategyQuery.isLoading}
          isError={strategyQuery.isError}
          onRetry={() => strategyQuery.refetch()}
          errorMessage={t('strategy.ideas.loadFailed', 'Fikirler yüklenemedi.')}
        >
          {!strategy ? (
            /* Mirrors StrategyConsolePage's own no-strategy branch: without a
               synthesized strategy there is nothing to propose, and the only
               useful thing this panel can do is point at the interview that
               creates one. */
            <div className="min-h-0 flex-1 overflow-y-auto">
              <EmptyState
                data-testid="ideas-no-strategy"
                icon={<Compass className="h-6 w-6" />}
                title={t('strategy.ideas.noStrategyTitle', 'Henüz bir stratejin yok')}
                description={t(
                  'strategy.ideas.noStrategyDesc',
                  'Markanı bir kez anlat; stratejist senin için bir pazarlama stratejisi ve ona bağlı kampanya fikirleri çıkarsın.',
                )}
                action={
                  <Button asChild>
                    <Link to="/onboarding/strategy">
                      {t('strategy.ideas.buildStrategy', 'Stratejimi kur')}
                    </Link>
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <header className="shrink-0 space-y-2 pb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-foreground">
                    {t('strategy.ideas.title', 'Kampanya fikirleri')}
                  </h2>
                  {strategy.archetype && (
                    <Badge tone="primary" size="sm">
                      {strategy.archetype}
                    </Badge>
                  )}
                  {canDecide && (
                    <Button
                      className="ms-auto"
                      size="sm"
                      variant="ghost"
                      onClick={() => setRefreshOpen(true)}
                      disabled={refresh.isPending}
                      loading={refresh.isPending}
                    >
                      <RefreshCw className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                      {t('strategy.ideas.refresh', 'Fikirleri yenile')}
                    </Button>
                  )}
                </div>

                {brief?.goals?.objective && (
                  <p className="line-clamp-1 text-caption text-muted-foreground">
                    {brief.goals.objective}
                  </p>
                )}

                {/*
                  Pillars and channel fit share ONE wrapped row rather than a row
                  each. They are the same kind of thing — the standing shape of
                  the strategy, read at a glance before the proposals below — and
                  as two stacked rows they cost most of a short panel's height,
                  which pushed the first idea card off the bottom. Together they
                  are the header; separately they were a second panel.
                */}
                {((brief?.contentPillars?.length ?? 0) > 0 || (brief?.channels?.length ?? 0) > 0) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="contents" data-testid="ideas-pillars">
                      {(brief?.contentPillars ?? []).map((p, i) => (
                        <Badge key={`${p.title}-${i}`} tone="neutral" size="sm">
                          {p.title}
                        </Badge>
                      ))}
                    </span>
                    <span className="contents" data-testid="ideas-channel-fit">
                    {(brief?.channels ?? []).slice(0, 3).map((c) => {
                      /* `fitScore` is a FRACTION (the backend's zod is
                         min(0).max(1)) — the console once fed the raw value to a
                         percentage bar and painted its strongest recommendation,
                         0.9, as a one-percent sliver. Clamp, then convert. */
                      const pct = Math.round(Math.min(Math.max(c.fitScore ?? 0, 0), 1) * 100);
                      return (
                        <Badge key={c.key} tone="info" size="sm">
                          {c.key} · {pct}%
                        </Badge>
                      );
                    })}
                    </span>
                  </div>
                )}
              </header>

              {/* The single scroll container: everything above and below is
                  shrink-0 so the card list is what grows and scrolls. */}
              <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pe-0.5">
                {failure && (
                  <Callout tone="danger" data-testid="ideas-failure">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium text-foreground">
                        {t('strategy.ideas.failureTitle', '«{{title}}» çalıştırılamadı', {
                          title: failure.title,
                        })}
                      </p>
                      {/* The backend's own message, verbatim and untranslated —
                          it is the only thing that says WHY. */}
                      <p className="break-words text-caption text-muted-foreground">
                        {failure.message}
                      </p>
                    </div>
                  </Callout>
                )}

                <QueryStateBoundary
                  isLoading={actionsQuery.isLoading}
                  isError={actionsQuery.isError}
                  onRetry={() => actionsQuery.refetch()}
                  errorMessage={t('strategy.ideas.actionsFailed', 'Fikirler yüklenemedi.')}
                >
                  {actions.length === 0 ? (
                    /* A different, calmer empty than the no-strategy one: the
                       strategy exists and the plan simply ran out, so the next
                       move is a refresh, not an onboarding wizard. */
                    <EmptyState
                      data-testid="ideas-none"
                      icon={<Lightbulb className="h-5 w-5" />}
                      title={t('strategy.ideas.emptyTitle', 'Bekleyen fikir yok')}
                      description={t(
                        'strategy.ideas.emptyDesc',
                        'Plandaki fikirlerin hepsini karara bağladın. Yeni bir dalga için “Fikirleri yenile” diyebilirsin.',
                      )}
                      action={
                        canDecide ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setRefreshOpen(true)}
                            disabled={refresh.isPending}
                          >
                            <RefreshCw className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                            {t('strategy.ideas.refresh', 'Fikirleri yenile')}
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <ul className="space-y-2.5">
                      {actions.map((a) => {
                        const meta = actionKindMeta(a.kind);
                        const prio = priorityMeta(a.priority);
                        /* Per-row pending. A shared mutation's `isPending` is
                           true for EVERY row while one is in flight, so the
                           gate is the id it was called with. */
                        const approving = approve.isPending && approve.variables === a.id;
                        const dismissing = dismiss.isPending && dismiss.variables === a.id;
                        const busy = approving || dismissing;

                        return (
                          <li
                            key={a.id}
                            data-testid={`idea-${a.id}`}
                            data-kind={a.kind}
                            className="rounded-lg border border-border p-3"
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge tone="neutral" size="sm">
                                {t(meta.labelKey, meta.label)}
                              </Badge>
                              <Badge tone={prio.tone} size="sm">
                                {t(prio.labelKey, prio.label)}
                              </Badge>
                            </div>

                            <p className="mt-1.5 text-sm font-medium text-foreground">{a.title}</p>
                            {a.rationale && (
                              <p className="mt-0.5 text-caption text-muted-foreground">
                                {a.rationale}
                              </p>
                            )}

                            <p
                              data-testid={`idea-what-${a.id}`}
                              className="mt-2 rounded-md bg-surface-muted p-2 text-caption text-muted-foreground"
                            >
                              <span className="font-medium text-foreground">
                                {t('strategy.ideas.whatLabel', 'Bu ne yapacak?')}
                              </span>{' '}
                              {t(meta.whatKey, meta.what)}
                            </p>

                            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                              {meta.affordance === 'MANUAL' ? (
                                /* No approve button EXISTS for this kind. The
                                   orchestrator has no executor registered for
                                   it, so approving would park the row at
                                   APPROVED forever — a button that reports
                                   success and does nothing. The tooltip carries
                                   the why; the sentence above carries it too,
                                   because a hover-only explanation is no
                                   explanation on a touch screen. */
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button asChild size="sm" variant="outline">
                                      <Link to={meta.manualRoute ?? '/accounts'}>
                                        <Plug className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                                        {t(
                                          meta.manualCtaKey ?? 'strategy.ideas.manual.cta',
                                          meta.manualCta ?? 'Kanalları bağla',
                                        )}
                                      </Link>
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {t(
                                      meta.manualHintKey ?? 'strategy.ideas.manual.hint',
                                      meta.manualHint ?? '',
                                    )}
                                  </TooltipContent>
                                </Tooltip>
                              ) : (
                                canDecide && (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => openApprove(a)}
                                    disabled={busy}
                                    loading={approving}
                                  >
                                    <Check className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                                    {t('strategy.ideas.approve', 'Onayla')}
                                  </Button>
                                )
                              )}

                              {canDecide && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => dismiss.mutate(a.id)}
                                  disabled={busy}
                                  loading={dismissing}
                                >
                                  <X className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                                  {t('strategy.ideas.dismiss', 'Yoksay')}
                                </Button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </QueryStateBoundary>
              </div>

              <footer className="shrink-0 space-y-1 pt-3">
                {canDecide ? (
                  /* Said once, here, rather than in four confirms: approving
                     dispatches the executor inside the request, so the button
                     really does sit there for a while. People who are not told
                     that click twice. */
                  <p className="text-micro text-muted-foreground">
                    {t(
                      'strategy.ideas.slowNote',
                      'Onayladığın fikir hemen çalıştırılır — bir dakikayı bulabilir.',
                    )}
                  </p>
                ) : (
                  <p className="text-micro text-muted-foreground" data-testid="ideas-readonly">
                    {t(
                      'strategy.ideas.readOnly',
                      'Fikirleri yalnızca yöneticiler onaylayabilir; sen görebilirsin.',
                    )}
                  </p>
                )}
                <Link
                  to="/studio/strategy"
                  className="inline-block text-caption text-muted-foreground hover:text-foreground"
                >
                  {t('strategy.ideas.openConsole', 'Strateji konsolunu aç')}
                </Link>
              </footer>
            </>
          )}
        </QueryStateBoundary>

        {/* Approve-behind-a-confirm, for the kinds that publish or spend. The
            body comes from the kind's own row in actionKinds.ts, so the warning
            and the executor can never describe different behaviour. */}
        <ConfirmDialog
          open={!!confirming}
          onOpenChange={(open) => {
            if (!open && !confirmingBusy) setConfirming(null);
          }}
          title={
            confirming
              ? t('strategy.ideas.confirmApproveTitle', '«{{title}}» onaylansın mı?', {
                  title: confirming.title,
                })
              : ''
          }
          description={
            confirmingMeta
              ? t(
                  confirmingMeta.confirmKey ?? confirmingMeta.whatKey,
                  confirmingMeta.confirm ?? confirmingMeta.what,
                )
              : undefined
          }
          confirmLabel={t('strategy.ideas.approve', 'Onayla')}
          cancelLabel={t('strategy.ideas.cancel', 'Vazgeç')}
          tone="danger"
          loading={confirmingBusy}
          onConfirm={() => {
            if (confirming) approve.mutate(confirming.id);
          }}
        />

        {/* Refresh-behind-a-confirm. Both costs are named: what it DELETES and
            what it SPENDS. Neither may be softened — the deletion takes DONE
            rows and the links to what they produced, and the spend is real. */}
        <ConfirmDialog
          open={refreshOpen}
          onOpenChange={(open) => {
            if (!open && !refresh.isPending) setRefreshOpen(false);
          }}
          title={t('strategy.ideas.refreshConfirmTitle', 'Fikirleri yenile')}
          description={t(
            'strategy.ideas.refreshConfirmBody',
            'Bu işlem mevcut TÜM fikirleri siler — tamamlanmış olanları ve onların ürettiği taslak, araştırma ve kampanya bağlantılarını da. Yerine yepyeni bir plan yazılır. Ayrıca çok adımlı bir AI sentezi çalıştırır: AI kredisi harcar ve yarıda kalsa bile iade edilmez. Bir dakikayı bulabilir.',
          )}
          confirmLabel={t('strategy.ideas.refreshConfirmCta', 'Sil ve yeniden üret')}
          cancelLabel={t('strategy.ideas.cancel', 'Vazgeç')}
          tone="danger"
          loading={refresh.isPending}
          onConfirm={() => refresh.mutate()}
        />
      </div>
    </TooltipProvider>
  );
}
