import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Check, Plug, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import {
  approveAction,
  dismissAction,
  getStrategy,
  listStrategyActions,
  type StrategyAction,
} from '../../../features/marketing/api/strategy.service';
import { hasMarketingRole, MarketingRole } from '../../../features/marketing/types';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { useOutOfCredits } from '../../../features/marketing/hooks/useOutOfCredits';
import { actionKindMeta, priorityMeta, resultRefLabel, type BadgeTone } from './actionKinds';
import { IDEA_FAILURE_KEY } from './ideaFailure';

/**
 * IdeaDetail — one idea, in full, on the page the operator opened from the
 * backlog list.
 *
 * WHY THIS FILE EXISTS. IdeasPanel used to render every idea expanded: its
 * rationale, its "Bu ne yapacak?" promise, the strategy it hangs off and its
 * decision buttons, all at once. Three ideas filled the region, so the backlog
 * was invisible and the panel's whole job — showing what there is to do next —
 * was the thing it could not do. The list keeps the titles; everything that is
 * only interesting once you have picked one lives here.
 *
 * THE DECISION MOVED HERE WITH THE TEXT, AND THAT IS THE POINT. Approving an
 * idea publishes under the workspace's name or spends its money, and the
 * sentence that says which is the consent the operator gives (see
 * actionKinds.ts). A bare "Onayla" on a title row would be that click without
 * that sentence. So the approve button sits next to the promise it belongs to,
 * and the list row keeps only the reversible half of triage.
 *
 * THERE IS NO SINGLE-ACTION ENDPOINT. `strategy.service.ts` exposes
 * `listStrategyActions(status)` and nothing that reads one action by id, so this
 * reads the SAME PROPOSED list, under the same query key, that the panel already
 * loaded — the row is in that cache, and inventing a `GET /strategy/actions/:id`
 * to fetch what we are already holding would give the two surfaces a way to
 * disagree about the same idea. The cost is that an id which is not in that list
 * cannot be rendered at all, which is why the not-found branch below says so
 * plainly instead of drawing an empty page.
 */

/** Status → badge, for the row's own lifecycle. Mirrors `ActionStatus`. */
const STATUS_META: Record<string, { tone: BadgeTone; labelKey: string; label: string }> = {
  PROPOSED: { tone: 'info', labelKey: 'strategy.ideas.status.proposed', label: 'Öneri' },
  APPROVED: { tone: 'primary', labelKey: 'strategy.ideas.status.approved', label: 'Onaylandı' },
  RUNNING: { tone: 'primary', labelKey: 'strategy.ideas.status.running', label: 'Çalışıyor' },
  DONE: { tone: 'success', labelKey: 'strategy.ideas.status.done', label: 'Tamamlandı' },
  FAILED: { tone: 'danger', labelKey: 'strategy.ideas.status.failed', label: 'Başarısız' },
  DISMISSED: { tone: 'neutral', labelKey: 'strategy.ideas.status.dismissed', label: 'Yoksayıldı' },
};

export default function IdeaDetail({ ideaId, onClose }: { ideaId: string; onClose: () => void }) {
  const { t } = useTranslation('marketing');
  const { notify: notifyOutOfCredits } = useOutOfCredits();
  const qc = useQueryClient();

  /**
   * Same split as the panel: GET /strategy and GET /strategy/actions need only
   * `reports.read`, so a REP reads the whole idea; approve and dismiss are
   * MANAGER + `settings.manage`, so those are withheld rather than rendered and
   * then 403'd.
   */
  const user = useMarketingAuthStore((s) => s.user);
  const canDecide = hasMarketingRole(user?.role, MarketingRole.MANAGER);

  // `meta: { silent: true }` for the panel's reason: main.tsx toasts every
  // non-401 query failure globally, and this surface draws its own error state.
  const strategyQuery = useQuery({
    queryKey: ['marketing', 'strategy'],
    queryFn: getStrategy,
    meta: { silent: true },
  });
  const strategy = strategyQuery.data ?? null;

  const actionsQuery = useQuery({
    queryKey: ['marketing', 'strategy', 'actions', 'PROPOSED'],
    queryFn: () => listStrategyActions('PROPOSED'),
    enabled: !!strategy,
    meta: { silent: true },
  });

  /**
   * The row as it came back from the FAILED probe after an approval that blew
   * up — see `approve` below.
   *
   * A failed run leaves the PROPOSED list, so without this the cache no longer
   * contains the idea and this page would replace the failure it is trying to
   * report with "that idea is gone". Holding the post-run row also means the
   * status badge and the result reference describe what ACTUALLY happened
   * rather than the pre-approval snapshot.
   */
  const [outcome, setOutcome] = useState<StrategyAction | null>(null);
  const [confirming, setConfirming] = useState(false);

  const listed = (actionsQuery.data ?? []).find((a) => a.id === ideaId);
  const idea = outcome?.id === ideaId ? outcome : listed;

  const invalidateProposed = () =>
    qc.invalidateQueries({ queryKey: ['marketing', 'strategy', 'actions', 'PROPOSED'] });

  /**
   * APPROVE. Two things about this endpoint are easy to get wrong and both are
   * load-bearing here.
   *
   * (1) THE RESPONSE IS A PRE-EXECUTION SNAPSHOT. `StrategyService.approveAction`
   * flips PROPOSED→APPROVED, captures the row, THEN awaits the orchestrator, and
   * returns the row it captured first — always `status: 'APPROVED', resultRef:
   * null`, even for a run that has already died. Rendering it would report every
   * failure in the product as a success, so we ignore it and go and ask.
   *
   * (2) BECAUSE THE SERVER AWAITS THE ORCHESTRATOR, the action is terminal by
   * the time this resolves: DONE or FAILED (the one kind that stays APPROVED has
   * no executor and therefore no approve button — see actionKinds.ts). So a
   * single read of the FAILED list either finds our id or proves the run
   * succeeded. Refetching PROPOSED instead would only tell us the row left the
   * queue, which is equally true of a failure.
   *
   * The probe is best-effort: if it throws we say plainly that we could not
   * confirm the outcome rather than claiming success.
   */
  const approve = useMutation({
    mutationFn: (id: string) => approveAction(id),
    onSuccess: async (_preExecutionSnapshot, id) => {
      const title = idea?.title ?? '';

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

      if (failed) {
        setOutcome(failed);
        // ...and again where it will OUTLIVE this panel. The detail is a
        // `?idea=` surface the operator closes as soon as they have read it,
        // and closing it used to take the only durable record of the failure
        // with it — the row has left PROPOSED, so reopening the link answers
        // "artık listede yok". The toast is a fine confirmation and a terrible
        // error report; IdeasPanel reads this key and holds the banner until
        // another decision clears it, which is where it lived before the split.
        qc.setQueryData(IDEA_FAILURE_KEY, {
          id, title: failed.title || title, resultRef: failed.resultRef ?? null,
        });
        await invalidateProposed();
        toast.error(
          t('strategy.ideas.toastFailed', '«{{title}}» çalıştırılamadı', {
            title: failed.title || title,
          }),
        );
        return;
      }

      // Closing BEFORE the invalidation is deliberate: the refetch drops this
      // row out of PROPOSED, and a page still mounted at that moment would
      // flash "this idea is no longer in the list" at someone whose approval
      // had just worked.
      toast[probed ? 'success' : 'info'](
        probed
          ? t('strategy.ideas.toastApproved', '«{{title}}» onaylandı ve çalıştırıldı', { title })
          : t(
              'strategy.ideas.toastApprovedUnverified',
              '«{{title}}» onaylandı — sonucunu doğrulayamadık, strateji konsolundan bakabilirsin',
              { title },
            ),
      );
      onClose();
      invalidateProposed();
    },
    onError: (e: unknown) =>
      notifyOutOfCredits(e, t('strategy.ideas.approveFailed', 'Fikir onaylanamadı')),
    // The confirm stays open for the whole (slow) round trip so its button can
    // carry the spinner; it closes once we know something, success or not.
    onSettled: () => setConfirming(false),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissAction(id),
    onSuccess: () => {
      qc.setQueryData(IDEA_FAILURE_KEY, null);
      onClose();
      invalidateProposed();
    },
    onError: (e: unknown) =>
      notifyOutOfCredits(e, t('strategy.ideas.dismissFailed', 'Fikir yoksayılamadı')),
  });

  const meta = actionKindMeta(idea?.kind);
  const prio = priorityMeta(idea?.priority);
  /* An unrecognised status renders the backend's own word for it and carries no
     key — the same reasoning as `priorityMeta`: that raw string is the only
     evidence of a new enum member the API started sending, and a generic
     translated fallback would throw it away. */
  const status = idea ? STATUS_META[idea.status] : undefined;
  const result = resultRefLabel(idea?.resultRef);
  const brief = strategy?.brief ?? null;
  const busy = approve.isPending || dismiss.isPending;

  const back = (
    <Button variant="ghost" size="sm" onClick={onClose}>
      <ArrowLeft className="me-1 h-3.5 w-3.5" aria-hidden="true" />
      {t('strategy.ideas.detail.back', 'Fikirlere dön')}
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="idea-detail">
      <QueryStateBoundary
        isLoading={strategyQuery.isLoading || actionsQuery.isLoading}
        /* BOTH reads, not just the list. The actions query is gated on the
           strategy one, so a failed GET /strategy leaves it disabled — never
           loading, never erroring — and the id then resolves to nothing. On the
           list's own error alone, that state fell through to the not-found
           branch and told the operator their idea had been decided or deleted,
           when all that happened is that we could not ask. */
        isError={strategyQuery.isError || actionsQuery.isError}
        onRetry={() => (strategyQuery.isError ? strategyQuery.refetch() : actionsQuery.refetch())}
        errorMessage={t('strategy.ideas.detail.loadFailed', 'Fikir yüklenemedi.')}
      >
        {!idea ? (
          /* The id is not in the PROPOSED list and we did not run it ourselves.
             That is an ordinary outcome rather than an error: the link is old,
             somebody else decided the idea, or a refresh rewrote the whole plan.
             Say so — a blank panel reads as a broken page, and the operator
             cannot tell the two apart. */
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EmptyState
              data-testid="idea-detail-notfound"
              title={t('strategy.ideas.detail.notFoundTitle', 'Bu fikir artık listede yok')}
              description={t(
                'strategy.ideas.detail.notFoundDesc',
                'Bu fikir karara bağlanmış, yoksayılmış ya da plan yenilenirken silinmiş olabilir. Bekleyen fikirlere dönebilirsin.',
              )}
              action={back}
            />
          </div>
        ) : (
          <>
            <header className="shrink-0 space-y-2 pb-3">
              <div className="flex items-center gap-2">{back}</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="neutral" size="sm">
                  {t(meta.labelKey, meta.label)}
                </Badge>
                <Badge tone={prio.tone} size="sm">
                  {/* No key means the label is the backend's own raw priority
                      string — see priorityMeta. */}
                  {prio.labelKey ? t(prio.labelKey, prio.label) : prio.label}
                </Badge>
                <Badge tone={status?.tone ?? 'neutral'} size="sm" data-testid="idea-detail-status">
                  {status ? t(status.labelKey, status.label) : idea.status}
                </Badge>
              </div>
              <h2 className="text-h3 font-semibold text-foreground">{idea.title}</h2>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pe-0.5">
              {idea.rationale && (
                <section>
                  <h3 className="text-caption font-medium text-foreground">
                    {t('strategy.ideas.detail.whyLabel', 'Neden bu fikir?')}
                  </h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">{idea.rationale}</p>
                </section>
              )}

              <p
                data-testid="idea-detail-what"
                className="rounded-md bg-surface-muted p-2.5 text-caption text-muted-foreground"
              >
                <span className="font-medium text-foreground">
                  {t('strategy.ideas.whatLabel', 'Bu ne yapacak?')}
                </span>{' '}
                {t(meta.whatKey, meta.what)}
              </p>

              {/* What the run produced, when it has already run. `resultRef`
                  carries BOTH outcomes — there is no error column on the row, so
                  a failure arrives as `error:<message>` in the very field that
                  otherwise points at what was made. `resultRefLabel` is what
                  keeps a stack-trace fragment from being rendered as a link to a
                  post that does not exist. */}
              {result?.failed ? (
                <Callout tone="danger" data-testid="idea-detail-failure">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium text-foreground">
                      {t('strategy.ideas.failureTitle', '«{{title}}» çalıştırılamadı', {
                        title: idea.title,
                      })}
                    </p>
                    {/* The backend's own message, verbatim and untranslated — it
                        is the only thing that says WHY. */}
                    <p className="break-words text-caption text-muted-foreground">
                      {result.message || t('strategy.ideas.failureUnknown', 'sebep kaydedilmemiş')}
                    </p>
                  </div>
                </Callout>
              ) : (
                result && (
                  <p data-testid="idea-detail-result" className="text-caption text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {t('strategy.ideas.detail.resultLabel', 'Sonuç')}
                    </span>{' '}
                    {t(result.labelKey, result.label)} · {result.id}
                  </p>
                )
              )}

              {/*
                The strategy this idea hangs off. It is here rather than in the
                list header because it is the same answer for every idea: as a
                permanent header it cost the backlog most of its height, and it
                is only ever read while judging ONE proposal — which is this
                page.
              */}
              {(brief?.goals?.objective ||
                (brief?.contentPillars?.length ?? 0) > 0 ||
                (brief?.channels?.length ?? 0) > 0) && (
                <section className="space-y-1.5 border-t border-border pt-3">
                  <h3 className="text-caption font-medium text-foreground">
                    {t('strategy.ideas.detail.strategyLabel', 'Bağlı olduğu strateji')}
                  </h3>
                  {brief?.goals?.objective && (
                    <p className="text-caption text-muted-foreground">{brief.goals.objective}</p>
                  )}
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
                           min(0).max(1)) — the console once fed the raw value to
                           a percentage bar and painted its strongest
                           recommendation, 0.9, as a one-percent sliver. Clamp,
                           then convert.

                           `null` when there is no score to convert, and the
                           badge then carries the channel name alone. The old
                           `?? 0` printed "reddit · 0%" for a brief whose channel
                           simply has no fitScore — an LLM-written JSON blob, so
                           the field's presence is a hope rather than a guarantee
                           — and 0% is not an absent rating, it is the strategist
                           saying this channel is worthless. */
                        const raw = c.fitScore;
                        const pct = Number.isFinite(raw)
                          ? Math.round(Math.min(Math.max(raw, 0), 1) * 100)
                          : null;
                        return (
                          <Badge key={c.key} tone="info" size="sm">
                            {pct === null ? c.key : `${c.key} · ${pct}%`}
                          </Badge>
                        );
                      })}
                    </span>
                  </div>
                </section>
              )}
            </div>

            <footer className="shrink-0 space-y-2 border-t border-border pt-3">
              {meta.affordance === 'MANUAL' ? (
                /* No approve button EXISTS for this kind. The orchestrator has
                   no executor registered for it, so approving would park the row
                   at APPROVED forever — a button that reports success and does
                   nothing. In the old card the reason was a tooltip for want of
                   room; here there is room, and a hover-only explanation is no
                   explanation on a touch screen. */
                <div className="space-y-1.5" data-testid="idea-detail-manual">
                  <p className="text-caption text-muted-foreground">
                    {t(meta.manualHintKey ?? 'strategy.ideas.manual.hint', meta.manualHint ?? '')}
                  </p>
                  <Button asChild size="sm" variant="outline">
                    <Link to={meta.manualRoute ?? '/accounts'}>
                      <Plug className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                      {t(
                        meta.manualCtaKey ?? 'strategy.ideas.manual.cta',
                        meta.manualCta ?? 'Kanalları bağla',
                      )}
                    </Link>
                  </Button>
                </div>
              ) : (
                canDecide && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        if (meta.affordance === 'APPROVE_CONFIRM') {
                          setConfirming(true);
                          return;
                        }
                        approve.mutate(idea.id);
                      }}
                      disabled={busy}
                      loading={approve.isPending}
                    >
                      <Check className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                      {t('strategy.ideas.approve', 'Onayla')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => dismiss.mutate(idea.id)}
                      disabled={busy}
                      loading={dismiss.isPending}
                    >
                      <X className="me-1 h-3.5 w-3.5" aria-hidden="true" />
                      {t('strategy.ideas.dismiss', 'Yoksay')}
                    </Button>
                  </div>
                )
              )}

              {canDecide ? (
                /* Approving dispatches the executor inside the request, so the
                   button really does sit there for a while. People who are not
                   told that click twice. */
                <p className="text-micro text-muted-foreground">
                  {t(
                    'strategy.ideas.slowNote',
                    'Onayladığın fikir hemen çalıştırılır — bir dakikayı bulabilir.',
                  )}
                </p>
              ) : (
                <p className="text-micro text-muted-foreground" data-testid="idea-detail-readonly">
                  {t(
                    'strategy.ideas.readOnly',
                    'Fikirleri yalnızca yöneticiler onaylayabilir; sen görebilirsin.',
                  )}
                </p>
              )}
            </footer>
          </>
        )}
      </QueryStateBoundary>

      {/* Approve-behind-a-confirm, for the kinds that publish or spend. The body
          comes from the kind's own row in actionKinds.ts, so the warning and the
          executor can never describe different behaviour. */}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !approve.isPending) setConfirming(false);
        }}
        title={
          idea
            ? t('strategy.ideas.confirmApproveTitle', '«{{title}}» onaylansın mı?', {
                title: idea.title,
              })
            : ''
        }
        description={t(meta.confirmKey ?? meta.whatKey, meta.confirm ?? meta.what)}
        confirmLabel={t('strategy.ideas.approve', 'Onayla')}
        cancelLabel={t('strategy.ideas.cancel', 'Vazgeç')}
        tone="danger"
        loading={approve.isPending}
        onConfirm={() => {
          if (idea) approve.mutate(idea.id);
        }}
      />
    </div>
  );
}
