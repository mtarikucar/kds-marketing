import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarClock, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import {
  createSocialPost,
  deleteSocialPost,
  hasFailedTarget,
  listSocialAccounts,
  listSocialPosts,
  publishSocialPostNow,
  scheduleSocialPost,
  socialQueryKeys,
  unscheduleSocialPost,
  updateSocialPost,
  type SocialAccount,
  type SocialPost,
} from '../../../features/marketing/api/socialPosts.service';
import {
  listContentCalendar,
  type CalendarItem,
} from '../../../features/marketing/api/contentCalendar.service';
import { listPendingApprovals } from '../../../features/marketing/api/growthBudget.service';
import { ApprovalQueue } from '../../../features/marketing/components/ApprovalQueue';
import { useWorkspaceProfile } from '../../../features/marketing/hooks/useWorkspaceProfile';
import { useOutOfCredits } from '../../../features/marketing/hooks/useOutOfCredits';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { hasMarketingRole, MarketingRole } from '../../../features/marketing/types';
import { PostComposerDialog, type PostComposerSubmit } from '../social/PostComposerDialog';
import { resolveZone, todayBoundsIso, zonedDayKey } from './todayBounds';
import { isBrokenSignal, rowSignal, TodayQueueRow, type QueueRow } from './TodayQueueRow';

/**
 * Where an edit left the post when it failed — which is the only thing the
 * operator actually needs from the error, and three different sentences.
 *
 * "The edit did not take" is not one message. A post that never moved is fine
 * and goes out tonight; a post whose plan was rebuilt from its old values went
 * out on the old plan, not the new one; a post left in drafts does not go out at
 * all. The panel printed the first of those for all three, which is how a rail
 * whose entire purpose is honesty ended up asserting the exact opposite of what
 * had just happened.
 */
type EditFailureState =
  /** Nothing moved. The post still publishes at the time it already had. */
  | 'SCHEDULE_KEPT'
  /** The content edit saved; the new time/targets did not, and the old plan is back. */
  | 'OLD_PLAN_RESTORED'
  /** The post is a DRAFT with no time on it. It will not publish at all. */
  | 'LEFT_UNSCHEDULED';

/** An edit failure that knows what it left behind. See {@link EditFailureState}. */
class EditPostError extends Error {
  constructor(
    readonly state: EditFailureState,
    readonly cause: unknown,
  ) {
    super('social post edit failed');
    this.name = 'EditPostError';
  }
}

/**
 * TodayQueuePanel — the Growth Studio's right rail: what goes out today.
 *
 * The owner asked for this one first, in these words: "sağda bugün neler
 * paylaşılacak onun listesi olsun". Everything below serves that sentence, and
 * four decisions in it are load-bearing enough to be worth stating up front.
 *
 * 1. TWO READS, NOT ONE. The social planner's post list is the only place a
 *    post's per-network targets exist, but it is not the authoritative set: a
 *    campaign slot the AI has planned and not yet materialised into a post
 *    exists solely as a `SocialCampaignItem`, and the content calendar is the
 *    only endpoint that reports it. Reading only the posts would draw an empty
 *    afternoon over a fully planned one. Reading only the calendar would lose
 *    every target and therefore every failure. So both are read and joined by
 *    id, with the calendar leading and the posts enriching.
 *
 * 2. THE TWO READS HAVE DIFFERENT DOORS. The whole SocialPlannerController is
 *    `@MarketingRoles('MANAGER')`; the content calendar needs only
 *    `reports.read`. A REP therefore gets exactly one half of this panel, and
 *    the manager-only queries are `enabled`-gated on the role rather than being
 *    allowed to fire and 403 — a rail that greets a sales rep with a stack of
 *    error toasts every morning is a rail they will close.
 *
 * 3. THE WINDOW IS THE WORKSPACE'S DAY, IN INSTANTS. See todayBounds.ts for the
 *    bug this avoids; the short version is that a bare `YYYY-MM-DD` sent to
 *    these endpoints is read as UTC midnight and slides the whole day by the
 *    workspace's offset, hiding the early-morning posts that a "what goes out
 *    today" rail exists to show.
 *
 * 4. A ROW NEVER BADGES ITSELF FROM `post.status`. That rule lives in
 *    `rowSignal` in TodayQueueRow.tsx and has its own essay there; it is the
 *    single most important correctness requirement on this screen.
 */
export default function TodayQueuePanel() {
  const { t } = useTranslation('marketing');
  const { notify: notifyOutOfCredits, notifyExhausted } = useOutOfCredits();
  const qc = useQueryClient();
  const user = useMarketingAuthStore((s) => s.user);
  const { workspace } = useWorkspaceProfile();
  const zone = resolveZone(workspace?.timezone);

  /**
   * MANAGER or above. Read through the repo's hierarchical helper rather than
   * `role === 'MANAGER'`, or an OWNER — who outranks a manager everywhere else
   * in the product — would be handed the read-only rail.
   */
  const canAct = hasMarketingRole(user?.role, MarketingRole.MANAGER);

  // ── the window, and the clock that moves it ────────────────────────────────
  //
  // Two different rhythms, deliberately kept in two different states.
  //
  // `nowMs` ticks every minute and decides only which rows have already passed
  // (the recessive weight). It is allowed to change often because nothing
  // fetches on it.
  //
  // The WINDOW must not move on that rhythm: `from`/`to` are half of two query
  // keys, so a fresh object every minute would refetch both lists 1440 times a
  // day and re-render the whole rail each time. It is recomputed only when the
  // workspace's zoned calendar day actually rolls over — which it must do, or a
  // tab left open through the night keeps showing yesterday's queue and
  // silently omits this morning's posts.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [win, setWin] = useState(() => makeWindow(zone));

  useEffect(() => {
    // The profile query resolves after first paint, so the first window was
    // built on the browser's fallback zone. Rebuild it once the workspace's own
    // zone lands — and only then, since `setWin` returning `prev` keeps the
    // object identity and therefore keeps the queries from refetching.
    setWin((prev) => (prev.zone === zone ? prev : makeWindow(zone)));
    const id = setInterval(() => {
      setNowMs(Date.now());
      setWin((prev) =>
        prev.zone === zone && prev.dayKey === zonedDayKey(zone, new Date()) ? prev : makeWindow(zone),
      );
    }, 60_000);
    return () => clearInterval(id);
  }, [zone]);

  const { from, to } = win;

  // ── reads ──────────────────────────────────────────────────────────────────
  //
  // Every one of these owns its own failure state below (the honest partial-data
  // lines), so all three opt out of main.tsx's global QueryCache.onError toast
  // via `meta: { silent: true }`. Without that a REP-adjacent 403 or a flaky
  // calendar would double-report: once as a toast, once inline.

  const postsQ = useQuery({
    queryKey: socialQueryKeys.postsIn(from, to),
    queryFn: () => listSocialPosts({ from, to }),
    enabled: canAct,
    meta: { silent: true },
  });

  const calendarQ = useQuery({
    // The exact key ContentCalendarPage uses. A near-miss here would not fail —
    // it would silently double the request and let the two screens disagree
    // about what is scheduled, which is the failure mode that is hardest to see.
    queryKey: ['content-calendar', from, to],
    queryFn: () => listContentCalendar(from, to),
    meta: { silent: true },
  });

  const accountsQ = useQuery({
    queryKey: socialQueryKeys.accounts,
    queryFn: listSocialAccounts,
    enabled: canAct,
    meta: { silent: true },
  });

  // The count that decides whether the approvals box exists at all. Shares
  // ['pending-approvals'] with ApprovalQueue itself, so the gate and the list
  // are reading one cache entry and can never disagree.
  const approvalsQ = useQuery({ queryKey: ['pending-approvals'], queryFn: listPendingApprovals });
  const waiting = approvalsQ.data?.length ?? 0;

  const accounts: SocialAccount[] = accountsQ.data ?? [];

  const rows = useMemo(
    () => buildRows(calendarQ.data ?? [], postsQ.data ?? []),
    [calendarQ.data, postsQ.data],
  );

  const brokenCount = rows.filter((r) => isBrokenSignal(rowSignal(r))).length;

  // Something to draw as soon as EITHER half lands. A manager whose calendar
  // read failed still gets their posts, and vice versa — the failed half is
  // named in its own line rather than taking the whole panel down with it.
  const haveSomething = calendarQ.isSuccess || (canAct && postsQ.isSuccess);
  const isLoading = !haveSomething && (calendarQ.isLoading || (canAct && postsQ.isLoading));
  const isError = !haveSomething && (calendarQ.isError || (canAct && postsQ.isError));

  // ── composer ──────────────────────────────────────────────────────────────

  const [composerOpen, setComposerOpen] = useState(false);
  const [editingPost, setEditingPost] = useState<SocialPost | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SocialPost | null>(null);

  const invalidate = () => {
    // `['marketing','social','posts']` is a PREFIX of the windowed key, so this
    // one call refreshes both this rail and the planner's unfiltered list.
    qc.invalidateQueries({ queryKey: socialQueryKeys.posts });
    qc.invalidateQueries({ queryKey: ['content-calendar'] });
  };

  const closeComposer = (open: boolean) => {
    setComposerOpen(open);
    if (!open) setEditingPost(null);
  };

  /**
   * Create, then schedule — two calls, in that order, because `POST /posts`
   * has no `scheduledAt`. Lifted verbatim from SocialPlannerPage so the rail
   * and the planner cannot drift into creating subtly different posts.
   */
  const createMutation = useMutation({
    mutationFn: async (values: PostComposerSubmit) => {
      const created = await createSocialPost({
        content: values.content,
        media: values.media,
        formats: values.formats,
        targetAccountIds: values.targetAccountIds,
        options: values.options,
      });
      if (values.scheduledAt && created?.id) {
        await scheduleSocialPost(created.id, {
          scheduledAt: values.scheduledAt,
          targetAccountIds: values.targetAccountIds,
          formats: values.formats,
        });
      }
      return created;
    },
    onSuccess: () => {
      invalidate();
      closeComposer(false);
      toast.success(t('studio.today.toast.created', 'Gönderi oluşturuldu'));
    },
    onError: () => toast.error(t('studio.today.toast.createFailed', 'Gönderi kaydedilemedi')),
  });

  /**
   * EDIT — the flow that was impossible until this rail existed.
   *
   * `PATCH /social-planner/posts/:id` runs `assertDraftPost` and 400s on
   * anything else, so a SCHEDULED post could be deleted and re-created but
   * never edited. The three calls below are that edit: pull it back to DRAFT,
   * patch it, put it back on the clock.
   *
   * They are ONE mutationFn on purpose. Run as three separate mutations, a
   * failure in the middle leaves the operator's post sitting in drafts with
   * nothing on screen saying so — it simply stops going out, tonight and every
   * night after. So EVERY step after the unschedule is wrapped: whatever throws,
   * the post is re-scheduled at the instant it ALREADY had, with the targets and
   * formats it already had, before the error is rethrown.
   *
   * The FINAL schedule needs that as much as the patch does, and for a longer
   * list of reasons. `/schedule` is not a formality that either succeeds or
   * leaves things alone: it re-attaches the targets, and it refuses outright on
   * "None of the selected accounts are connected" and on "Post has no targets" —
   * both of them reachable by an ordinary edit, from an account disconnected
   * since the post was written or a checkbox unticked by mistake. A bare network
   * blip does it too. Unwrapped, that turns a post which was SCHEDULED a moment
   * ago into a DRAFT with `scheduledAt: null`, and the operator is told the edit
   * merely failed and the time was kept.
   *
   * The rollback's own failure is swallowed as an ERROR but not as a FACT. There
   * is exactly one error worth putting in front of the operator — the reason the
   * edit did not take — and replacing it with "could not restore the schedule"
   * would hide the cause behind the consequence. The consequence still has to be
   * reported, so it comes back as {@link EditFailureState} and decides which
   * sentence the toast prints.
   */
  const editMutation = useMutation({
    mutationFn: async ({ post, values }: { post: SocialPost; values: PostComposerSubmit }) => {
      const originalAt = post.scheduledAt;
      const originalTargets = post.targets.map((tg) => tg.socialAccountId);
      const originalFormats = post.options?.formats;
      const wasScheduled = post.status !== 'DRAFT';

      /**
       * Put the post back exactly where it was — same instant, same targets,
       * same formats — and report the outcome rather than throwing.
       *
       * THREE outcomes, not two, because "there was nothing to put back" is not
       * a failed rescue. A FAILED post can hold `scheduledAt: null` (publish-now
       * on a draft that lost every target lands exactly there), and it is
       * editable, so this path is reachable — and a boolean would have the
       * caller tell that operator their schedule was destroyed, when the post
       * never had one. The sentence would be false in the one place the screen
       * is asking to be believed.
       */
      const restoreSchedule = async (): Promise<'RESTORED' | 'NOTHING_TO_RESTORE' | 'LOST'> => {
        if (!originalAt) return 'NOTHING_TO_RESTORE';
        try {
          await scheduleSocialPost(post.id, {
            scheduledAt: originalAt,
            targetAccountIds: originalTargets,
            formats: originalFormats,
          });
          return 'RESTORED';
        } catch {
          return 'LOST';
        }
      };

      if (wasScheduled) {
        try {
          await unscheduleSocialPost(post.id);
        } catch (err) {
          // Nothing has moved yet — the post is still on the clock it was on.
          throw new EditPostError('SCHEDULE_KEPT', err);
        }
      }

      try {
        await updateSocialPost(post.id, {
          content: values.content,
          media: values.media,
          formats: values.formats,
          targetAccountIds: values.targetAccountIds,
          options: values.options,
        });
      } catch (err) {
        // A post that was already a draft has lost nothing; one that was on the
        // clock has, unless the restore puts it back.
        throw new EditPostError(
          !wasScheduled || (await restoreSchedule()) !== 'LOST' ? 'SCHEDULE_KEPT' : 'LEFT_UNSCHEDULED',
          err,
        );
      }

      // `values.scheduledAt ?? originalAt`, deliberately — and NOT because the
      // composer omits the time on an untouched edit. It does not:
      // `PostComposerDialog` seeds `scheduledAt` from `post.scheduledAt` when it
      // opens and re-serialises whatever is in the field on submit, so an edit
      // that never went near the time still carries it. The only way to arrive
      // here without one is the operator CLEARING the field, which reads as
      // "take this off the schedule" — and the fallback overrides that.
      //
      // It stays, because the two possible mistakes are not the same size.
      // Reading an empty field as "unschedule" acts on a guess, and its failure
      // mode is the silent one this whole mutation exists to prevent: the post
      // stops going out and nothing says so. Keeping the recorded time acts on
      // the post's own stated intent, and if the operator really did mean to
      // unschedule it, "Taslağa al" sits in the same row's menu, one click away,
      // with an immediate and visible result. Telling the two apart properly
      // needs an absent-vs-emptied signal in `PostComposerSubmit`, which is the
      // planner's shared contract and not this rail's to change unilaterally.
      const nextAt = values.scheduledAt ?? originalAt;
      if (nextAt) {
        try {
          await scheduleSocialPost(post.id, {
            scheduledAt: nextAt,
            targetAccountIds: values.targetAccountIds,
            formats: values.formats,
          });
        } catch (err) {
          // The patch is already saved, so the edit itself did take. What did
          // not is the plan — and which sentence is true depends on whether
          // there WAS one. A post that arrived here with no `scheduledAt` has
          // lost nothing by ending up a draft; only a post that had a time and
          // could not get it back is genuinely stranded.
          const restored = await restoreSchedule();
          throw new EditPostError(
            restored === 'LOST' ? 'LEFT_UNSCHEDULED' : 'OLD_PLAN_RESTORED',
            err,
          );
        }
      }
      return post.id;
    },
    onSuccess: () => {
      invalidate();
      closeComposer(false);
      toast.success(t('studio.today.toast.updated', 'Gönderi güncellendi'));
    },
    onError: (err) => {
      // ALWAYS refetch, even though nothing succeeded. The rail is drawing this
      // row from a cached list that may now be describing a post that no longer
      // exists in that state — a SCHEDULED badge over a post sitting in drafts
      // is the row quietly confirming the lie the toast is trying to correct.
      invalidate();

      // A non-EditPostError can only come from the two reads at the top of the
      // mutationFn, before any request was made, so the schedule really is
      // untouched in that case too.
      const state = err instanceof EditPostError ? err.state : 'SCHEDULE_KEPT';

      if (state === 'LEFT_UNSCHEDULED') {
        toast.error(
          t(
            'studio.today.toast.updateLeftDraft',
            'Gönderi taslağa düştü ve planı silindi — bu haliyle yayınlanmayacak. Zamanı yeniden ver.',
          ),
        );
        return;
      }
      if (state === 'OLD_PLAN_RESTORED') {
        toast.error(
          t(
            'studio.today.toast.updateNotApplied',
            'Yeni zaman ve hesaplar uygulanamadı — gönderi eski planına geri alındı.',
          ),
        );
        return;
      }
      toast.error(
        t('studio.today.toast.updateFailed', 'Gönderi güncellenemedi — planlanan zamanı korundu'),
      );
    },
  });

  // ── row mutations ─────────────────────────────────────────────────────────
  //
  // All four take the post id as their variable, so a row can ask "is it ME
  // that is busy?" with `variables === row.id`. Gating on the bare `isPending`
  // is the bug this repo has already paid for twice: one shared mutation puts
  // every row in the list into a spinner, and the operator cannot tell which
  // post they actually clicked.

  /**
   * PUBLISH NOW — where a 200 is not a success report.
   *
   * `publishNow` catches per target: a network that throws is written FAILED and
   * the loop carries on, so the request resolves with the post whatever happened
   * to it. All three networks dead resolves 200 with `status: 'FAILED'`; two of
   * three dead resolves 200 with `status: 'PUBLISHED'`, because the post is
   * marked published the moment ONE target lands. `onError` therefore only ever
   * sees transport and authorisation failures, and a green "Gönderi yayınlandı"
   * over a post that reached nobody is a toast contradicting the row it was
   * fired from — the row gets this right (`rowSignal` reads the targets), which
   * makes the toast the one thing on screen that is wrong.
   *
   * So the resolved post is READ, in the same order the row reads it: the post's
   * own FAILED first, since a post that never attempted a target has nothing for
   * `hasFailedTarget` to find, then the half-published case.
   */
  const publishNow = useMutation({
    mutationFn: (postId: string) => publishSocialPostNow(postId),
    onSuccess: (published) => {
      invalidate();
      // A publish that died on credits RESOLVES — the failure rides on the
      // targets as a string — so without this the only trace of the billing
      // wall is a `title=` tooltip on one chip.
      if (published?.targets?.some((tg) => tg.error?.includes('AI_CREDITS_EXHAUSTED'))) {
        notifyExhausted();
      }
      if (published?.status === 'FAILED') {
        toast.error(
          t(
            'studio.today.toast.publishAllFailed',
            'Gönderi hiçbir hesapta yayınlanamadı — satırdaki hesap rozetleri nedenini gösteriyor.',
          ),
        );
        return;
      }
      if (published && hasFailedTarget(published)) {
        toast.warning(
          t(
            'studio.today.toast.publishPartial',
            'Gönderi bazı hesaplarda yayınlanamadı — satırdaki hesap rozetleri hangisinin düştüğünü gösteriyor.',
          ),
        );
        return;
      }
      toast.success(t('studio.today.toast.published', 'Gönderi yayınlandı'));
    },
    onError: (e: unknown) =>
      notifyOutOfCredits(e, t('studio.today.toast.publishFailed', 'Gönderi yayınlanamadı')),
  });

  const reschedule = useMutation({
    mutationFn: ({ post, at }: { post: SocialPost; at: string }) =>
      scheduleSocialPost(post.id, {
        scheduledAt: at,
        targetAccountIds: post.targets.map((tg) => tg.socialAccountId),
        formats: post.options?.formats,
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t('studio.today.toast.rescheduled', 'Zaman güncellendi'));
    },
    onError: () => toast.error(t('studio.today.toast.rescheduleFailed', 'Zaman güncellenemedi')),
  });

  const unschedule = useMutation({
    mutationFn: (postId: string) => unscheduleSocialPost(postId),
    onSuccess: () => {
      invalidate();
      toast.success(t('studio.today.toast.drafted', 'Gönderi taslaklara alındı'));
    },
    onError: () => toast.error(t('studio.today.toast.draftFailed', 'Gönderi taslağa alınamadı')),
  });

  const remove = useMutation({
    mutationFn: (postId: string) => deleteSocialPost(postId),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('studio.today.toast.deleted', 'Gönderi silindi'));
    },
    onError: () => toast.error(t('studio.today.toast.deleteFailed', 'Gönderi silinemedi')),
  });

  /** Is any mutation in flight for THIS row — and only this row. */
  const rowBusy = (id: string) =>
    (publishNow.isPending && publishNow.variables === id) ||
    (unschedule.isPending && unschedule.variables === id) ||
    (remove.isPending && remove.variables === id) ||
    (reschedule.isPending && reschedule.variables?.post.id === id) ||
    (editMutation.isPending && editMutation.variables?.post.id === id);

  return (
    // Fills the column the parent gives it: header fixed, list scrolling,
    // approvals pinned under it. No Card and no PageHeader — the parent mounts
    // this inside one, and a second border here would draw a box in a box.
    <div className="flex h-full min-h-0 flex-col" data-testid="today-queue">
      <header className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
        <h2 className="text-base font-semibold text-foreground">
          {t('studio.today.title', 'Bugün')}
        </h2>
        {rows.length > 0 && (
          <Badge size="sm" tone="neutral" data-testid="tq-count">
            {rows.length}
          </Badge>
        )}
        {/* The rail is a scrolling list, so a failure ten rows down is invisible
            until you scroll to it. This is the same bill the home screen's tab
            badge pays: a count in the header, so the column can speak about a
            row that is not currently on screen. */}
        {brokenCount > 0 && (
          <Badge
            size="sm"
            tone="danger"
            data-testid="tq-broken-count"
            aria-label={t('studio.today.brokenCount', '{{count}} gönderide sorun var', {
              count: brokenCount,
            })}
          >
            {brokenCount}
          </Badge>
        )}
        {canAct && (
          <Button size="sm" className="ms-auto" onClick={() => { setEditingPost(null); setComposerOpen(true); }}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('studio.today.new', 'Yeni gönderi')}
          </Button>
        )}
      </header>

      {/* HONEST PARTIAL DATA, one line per thing we could not read — never one
          merged "something went wrong". The two halves fail for different
          reasons and cost the reader different things: without the posts the
          rows lose their targets and their actions; without the calendar the
          rows lose the campaign slots that have no post yet. Folding them
          together would hide whichever is smaller. */}
      {canAct && postsQ.isError && (
        <p data-testid="tq-posts-unread" role="status" className="shrink-0 pb-2 text-caption text-warning">
          {t(
            'studio.today.postsUnread',
            'Gönderi listesi okunamadı — aşağıdakiler takvimden geliyor, hesap durumları ve işlemler eksik.',
          )}
        </p>
      )}
      {calendarQ.isError && haveSomething && (
        <p data-testid="tq-calendar-unread" role="status" className="shrink-0 pb-2 text-caption text-warning">
          {t(
            'studio.today.calendarUnread',
            'Takvim okunamadı — henüz gönderisi oluşturulmamış kampanya içerikleri bu listede görünmüyor.',
          )}
        </p>
      )}
      {!canAct && (
        <p data-testid="tq-readonly" role="status" className="shrink-0 pb-2 text-caption text-muted-foreground">
          {t(
            'studio.today.readOnly',
            'Bu liste salt okunur — yayınlama, düzenleme ve silme için yönetici yetkisi gerekiyor.',
          )}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <QueryStateBoundary
          isLoading={isLoading}
          isError={isError}
          onRetry={() => {
            calendarQ.refetch();
            if (canAct) postsQ.refetch();
          }}
          errorMessage={t('studio.today.failed', 'Bugünün listesi yüklenemedi.')}
          retryLabel={t('common.retry', 'Yeniden dene')}
        >
          {rows.length === 0 ? (
            <EmptyState
              data-testid="tq-empty"
              icon={<CalendarClock className="h-5 w-5" />}
              title={t('studio.today.empty.title', 'Bugün planlanmış bir paylaşım yok')}
              description={t(
                'studio.today.empty.desc',
                'Bir gönderi planladığında ya da kampanya bir slot açtığında burada görürsün.',
              )}
              action={
                canAct ? (
                  <Button size="sm" onClick={() => { setEditingPost(null); setComposerOpen(true); }}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t('studio.today.new', 'Yeni gönderi')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <TodayQueueRow
                  key={`${row.kind}-${row.id}`}
                  row={row}
                  zone={zone}
                  accounts={accounts}
                  canAct={canAct}
                  now={nowMs}
                  busy={rowBusy(row.id)}
                  publishing={publishNow.isPending && publishNow.variables === row.id}
                  onPublishNow={(post) => publishNow.mutate(post.id)}
                  onReschedule={(post, at) => reschedule.mutate({ post, at })}
                  onUnschedule={(post) => unschedule.mutate(post.id)}
                  onEdit={(post) => {
                    setEditingPost(post);
                    setComposerOpen(true);
                  }}
                  onDelete={(post) => setDeleteTarget(post)}
                />
              ))}
            </ul>
          )}
        </QueryStateBoundary>
      </div>

      {/* APPROVALS, only when something is actually waiting. A permanently empty
          "Onay bekleyenler" box trains people to ignore the one box that must
          never be ignored — the same gate the home screen uses, for the same
          reason. Pinned below the scrolling list rather than inside it, so a
          long queue of posts can never push it out of view. */}
      {waiting > 0 && (
        <section data-testid="tq-approvals" className="mt-3 max-h-[35%] shrink-0 overflow-y-auto border-t border-border pt-3">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            {t('studio.today.waitingOnYou', 'Onayını bekliyor')}
            <Badge size="sm" tone="warning">
              {waiting}
            </Badge>
          </h3>
          <ApprovalQueue />
        </section>
      )}

      {/* Fully controlled and portal-rendered, so it mounts straight from the
          rail — the same dialog the planner uses, not a second composer. */}
      {canAct && (
        <PostComposerDialog
          open={composerOpen}
          onOpenChange={closeComposer}
          accounts={accounts}
          post={editingPost}
          isPending={createMutation.isPending || editMutation.isPending}
          onSubmit={(values) =>
            editingPost
              ? editMutation.mutate({ post: editingPost, values })
              : createMutation.mutate(values)
          }
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('studio.today.deleteTitle', 'Gönderi silinsin mi?')}
        // Said plainly because it is true: `DELETE /posts/:id` cascades the
        // targets and there is no soft-delete column to recover from.
        description={t(
          'studio.today.deleteDesc',
          'Bu gönderi kalıcı olarak silinir. Geri alınamaz.',
        )}
        confirmLabel={t('studio.today.delete', 'Sil')}
        cancelLabel={t('common.cancel', 'Vazgeç')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface RailWindow {
  zone: string;
  dayKey: string;
  from: string;
  to: string;
}

const makeWindow = (zone: string): RailWindow => ({
  zone,
  dayKey: zonedDayKey(zone, new Date()),
  ...todayBoundsIso(zone),
});

/**
 * The join.
 *
 * The calendar leads because it is the authoritative set — it is the only read
 * that reports a campaign slot with no post behind it yet. Its SOCIAL_POST rows
 * are then enriched from the planner's list, which is the only read that
 * carries targets.
 *
 * The second loop is not redundant. The two endpoints filter the same column
 * with the same bounds today, but they are different services with different
 * dedupe rules — the calendar deliberately SUPPRESSES a campaign item once its
 * post is scheduled, and it is one small change away from suppressing something
 * else. A post the planner returned and the calendar did not is a real thing
 * that is really going out today, and dropping it because the other read did
 * not mention it would be the rail failing at its only job. `seen` keeps it
 * from being drawn twice.
 */
export function buildRows(calendar: CalendarItem[], posts: SocialPost[]): QueueRow[] {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const rows: QueueRow[] = [];

  for (const item of calendar) {
    if (item.type === 'SOCIAL_POST') {
      seen.add(item.id);
      const p = byId.get(item.id);
      rows.push({
        id: item.id,
        kind: 'POST',
        // The post's own values win wherever it has them. The calendar
        // truncates its title at 80 characters, and — more than cosmetics —
        // these are two independent queries that settle at different moments,
        // so after a reschedule the post list can be a refetch ahead of the
        // calendar. Sorting and printing the row by the stale copy would put
        // it back in its old slot for as long as that lasted.
        at: p?.scheduledAt ?? item.scheduledAt,
        title: p?.content ?? item.title,
        post: p ?? null,
        calendarStatus: item.status,
      });
    } else {
      rows.push({
        id: item.id,
        kind: 'CAMPAIGN_ITEM',
        at: item.scheduledAt,
        title: item.title,
        post: null,
        calendarStatus: item.status,
      });
    }
  }

  for (const post of posts) {
    if (seen.has(post.id) || !post.scheduledAt) continue;
    rows.push({
      id: post.id,
      kind: 'POST',
      at: post.scheduledAt,
      title: post.content,
      post,
      calendarStatus: post.status,
    });
  }

  // Ascending: a queue is read in the order it fires. Rows whose instant does
  // not parse sort last rather than poisoning the comparator with NaN.
  return rows.sort((a, b) => (safeTime(a.at) - safeTime(b.at)) || a.id.localeCompare(b.id));
}

const safeTime = (iso: string) => {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
};
