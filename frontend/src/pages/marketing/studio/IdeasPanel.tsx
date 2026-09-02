import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, Compass, Lightbulb, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Callout } from '@/components/ui/Callout';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import {
  dismissAction,
  getStrategy,
  listStrategyActions,
  refreshStrategy,
} from '../../../features/marketing/api/strategy.service';
import { hasMarketingRole, MarketingRole } from '../../../features/marketing/types';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { useOutOfCredits } from '../../../features/marketing/hooks/useOutOfCredits';
import { IDEA_FAILURE_KEY, type IdeaFailure } from './ideaFailure';
import { actionKindMeta, priorityMeta } from './actionKinds';

/**
 * The Growth Studio's IDEAS BACKLOG: one line per campaign idea, newest plan
 * first, and a route into each one.
 *
 * THERE IS NO "IDEA" ENTITY IN THIS PRODUCT, AND THAT IS THE POINT. The owner
 * asked for "kampanya fikirleri ve bu kampanya fikirleri için neler yapılması
 * gerekiyor, stratejiye bağlı bir bölüm", and a new Idea table would have been
 * the wrong answer twice over: it would be a second, weaker copy of something
 * that already exists, and it would be inert — a list of suggestions nobody can
 * act on without leaving the screen. A `StrategyAction` at status PROPOSED is
 * already all three things at once: the idea (title), the argument for it
 * (rationale), and an executor-ready payload the orchestrator can run the moment
 * a human says yes. So this panel is a view onto that queue, sharing
 * StrategyConsolePage's exact query keys — the two surfaces read one cache and
 * therefore cannot disagree about what is proposed.
 *
 * WHY IT IS A LIST OF TITLES AND NOT A LIST OF CARDS. It used to be cards: each
 * idea rendered its rationale, its "Bu ne yapacak?" promise and its decision
 * buttons inline. Three of them filled the region, so the backlog — the one
 * thing a list of proposals is for — was never visible, and the owner's verdict
 * was exactly that ("fikirler büyüsün, fikir başlığı olsun, detayları fikrin
 * sayfasının içine gidip detaylandırıp bakabiliriz"). A row now carries the
 * title and the two facts you triage on, kind and priority; IdeaDetail carries
 * the rest.
 *
 * WHY APPROVE IS NOT ON THE ROW AND DISMISS IS. Approving publishes under the
 * workspace's name or spends its money, and the sentence naming which is the
 * consent the operator gives (actionKinds.ts). Put the button on a bare title
 * row and that click happens without that sentence, so approve lives in the
 * detail beside the promise, behind the same confirms as before. Dismissing
 * publishes nothing and spends nothing — it is the triage gesture a backlog
 * needs to have on the row, and holding it hostage to a navigation would make
 * clearing a stale plan a chore.
 *
 * WHAT THIS PANEL IS NOT. It is not a second strategy console. The full console
 * (autonomy lane, identity, per-channel fit bars, community channel connection)
 * stays at /studio/strategy and is linked from the footer. Duplicating it here
 * would put two editable copies of the same governance controls on two screens,
 * which is how a workspace ends up with an autonomy lane nobody remembers
 * arming.
 */
export default function IdeasPanel() {
  const { t } = useTranslation('marketing');
  // Dismiss and refresh both run against AI-billed endpoints, so both can hit
  // the credit wall and both used to echo the backend's English sentence.
  const { notify: notifyOutOfCredits } = useOutOfCredits();
  const qc = useQueryClient();

  /**
   * READS vs DECISIONS have different backend gates, and conflating them is
   * what turns this panel into a wall of red toasts for a REP.
   *
   * GET /strategy and GET /strategy/actions need only `reports.read`, so both
   * queries run for everybody — a rep should be able to SEE what the strategist
   * proposed. Dismiss and refresh are `@MarketingRoles('MANAGER')` plus
   * `settings.manage`, so those affordances are withheld and replaced by one
   * quiet line. Rendering the buttons anyway and letting the 403 explain it is
   * the pattern this codebase has already paid for.
   */
  const user = useMarketingAuthStore((s) => s.user);
  const canDecide = hasMarketingRole(user?.role, MarketingRole.MANAGER);

  /**
   * `meta: { silent: true }` on both queries: main.tsx installs a global
   * QueryCache.onError that toasts every non-401 failure, and this panel draws
   * its own error state through QueryStateBoundary. Without the opt-out a failed
   * load reports itself twice — once inline and once as a toast that says the
   * same thing with less context.
   */
  const strategyQuery = useQuery({
    queryKey: ['marketing', 'strategy'],
    queryFn: getStrategy,
    meta: { silent: true },
  });

  /**
   * GET /strategy returns 200 with a NULL BODY when the workspace has never been
   * through onboarding — it is `findUnique`, not a 404. So "no strategy" is a
   * successful query with `data === null`, and any code that waits for an error
   * to detect it waits forever.
   */
  const strategy = strategyQuery.data ?? null;

  const actionsQuery = useQuery({
    queryKey: ['marketing', 'strategy', 'actions', 'PROPOSED'],
    queryFn: () => listStrategyActions('PROPOSED'),
    enabled: !!strategy,
    meta: { silent: true },
  });

  const [refreshOpen, setRefreshOpen] = useState(false);

  const invalidateProposed = () =>
    qc.invalidateQueries({ queryKey: ['marketing', 'strategy', 'actions', 'PROPOSED'] });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissAction(id),
    onSuccess: () => invalidateProposed(),
    onError: (e: unknown) =>
      notifyOutOfCredits(e, t('strategy.ideas.dismissFailed', 'Fikir yoksayılamadı')),
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
      // `actionCount` is OPTIONAL on the client type, and `?? 0` turned that
      // "the server did not say" into the flat claim that the expensive,
      // destructive re-synthesis produced NOTHING — over a list that is at the
      // same moment refetching and about to fill with ideas. A count we were not
      // given is not a count of zero; say the plan is ready and let the list
      // below it do the counting.
      toast.success(
        Number.isFinite(r.actionCount)
          ? t('strategy.ideas.refreshDone', 'Yeni plan hazır: {{count}} fikir', {
              count: r.actionCount,
            })
          : t('strategy.ideas.refreshDoneNoCount', 'Yeni plan hazır'),
      );
    },
    onError: (e: unknown) =>
      notifyOutOfCredits(e, t('strategy.ideas.refreshFailed', 'Fikirler yenilenemedi')),
    onSettled: () => setRefreshOpen(false),
  });

  /**
   * The backend already returns the plan sorted HIGH→MEDIUM→LOW and then oldest
   * first. This deliberately does NOT re-sort it: a second sort with a different
   * tiebreak is exactly how this panel and the strategy console would end up
   * naming different ideas as "next" while reading the same cache.
   */
  const actions = actionsQuery.data ?? [];

  /**
   * The detail lives at `?idea=<id>` on this same screen, so opening one is a
   * real <Link> — right-clickable, bookmarkable, closed by the back button —
   * rather than a callback drilled through the lazy boundary this panel sits
   * behind. The other params are carried over because `?tool=` is on this URL
   * too and dropping it would close whichever drawer is open.
   */
  const [params] = useSearchParams();
  const ideaHref = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('idea', id);
    return { search: `?${next.toString()}` };
  };

  /**
   * The last approval that FAILED, reported by IdeaDetail and held here.
   *
   * It lives in the cache rather than in either component because the detail
   * unmounts as soon as the operator closes `?idea=`, and this is the only
   * place the reason survives — the row has left PROPOSED, so the link cannot
   * be reopened to read it again. Never fetched; the detail writes it, this
   * reads it, and the next decision clears it.
   */
  const failure = useQuery<IdeaFailure | null>({
    queryKey: IDEA_FAILURE_KEY,
    queryFn: () => null,
    enabled: false,
    initialData: null,
  }).data;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ideas-panel">
      {failure && (
        <Callout tone="danger" className="mb-2 shrink-0" data-testid="ideas-failure">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1">
              {t('strategy.ideas.failedBanner', '«{{title}}» çalıştırılamadı: {{reason}}', {
                title: failure.title,
                reason: failure.resultRef?.startsWith('error:')
                  ? failure.resultRef.slice('error:'.length)
                  : t('strategy.ideas.failureUnknown', 'sebep kaydedilmemiş'),
              })}
            </span>
            <button
              type="button"
              aria-label={t('strategy.ideas.dismissFailure', 'Bu uyarıyı kapat')}
              onClick={() => qc.setQueryData(IDEA_FAILURE_KEY, null)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </Callout>
      )}
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
            {/*
              The header is one row and stays one row. Everything that used to
              live under it — the objective, the content pillars, the channel fit
              — is the same answer for every idea in the list, and as a permanent
              three-row header it cost the backlog most of its height. It reads
              once, next to the proposal being judged, in IdeaDetail.
            */}
            <header className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
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
            </header>

            {/* The single scroll container: the header and footer are shrink-0
                so the backlog is what grows and scrolls. */}
            <div className="min-h-0 flex-1 overflow-y-auto pe-0.5">
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
                  <ul className="divide-y divide-border">
                    {actions.map((a) => {
                      const meta = actionKindMeta(a.kind);
                      const prio = priorityMeta(a.priority);
                      /* Per-row pending. A shared mutation's `isPending` is true
                         for EVERY row while one is in flight, so the gate is the
                         id it was called with. */
                      const dismissing = dismiss.isPending && dismiss.variables === a.id;

                      return (
                        <li
                          key={a.id}
                          data-testid={`idea-${a.id}`}
                          data-kind={a.kind}
                          className="flex items-center gap-2"
                        >
                          <Link
                            to={ideaHref(a.id)}
                            data-testid={`idea-open-${a.id}`}
                            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-2 hover:bg-surface-muted"
                          >
                            {/* One line, always: rows of a uniform height are
                                what makes a backlog scannable, and a long
                                LLM-written title would otherwise wrap to three.
                                `title` keeps the full text reachable. */}
                            <span
                              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                              title={a.title}
                            >
                              {a.title}
                            </span>
                            <Badge tone="neutral" size="sm" className="shrink-0">
                              {t(meta.labelKey, meta.label)}
                            </Badge>
                            <Badge tone={prio.tone} size="sm" className="shrink-0">
                              {/* No key means the label is the backend's own raw
                                  priority string — see priorityMeta. */}
                              {prio.labelKey ? t(prio.labelKey, prio.label) : prio.label}
                            </Badge>
                            <ChevronRight
                              className="h-4 w-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          </Link>

                          {canDecide && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="shrink-0"
                              onClick={() => dismiss.mutate(a.id)}
                              disabled={dismissing}
                              loading={dismissing}
                            >
                              <X className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                              {t('strategy.ideas.dismiss', 'Yoksay')}
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </QueryStateBoundary>
            </div>

            <footer className="shrink-0 space-y-1 pt-3">
              {!canDecide && (
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

      {/* Refresh-behind-a-confirm. Both costs are named: what it DELETES and
          what it SPENDS. Neither may be softened — the deletion takes DONE rows
          and the links to what they produced, and the spend is real. */}
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
  );
}
