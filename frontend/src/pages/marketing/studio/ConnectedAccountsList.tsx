import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Plug } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';
import { LineTrend, compactNumber, dayRange, fullNumber } from '@/components/charts';
import {
  getSocialInsights,
  socialInsightsKey,
  type OrganicAccountRow,
  type SocialInsightsResponse,
} from '../../../features/marketing/api/socialInsights.service';
import {
  listSocialPosts,
  socialQueryKeys,
  type SocialPost,
} from '../../../features/marketing/api/socialPosts.service';
import { useConnections } from '../accounts/hooks';
import { ProviderLogo } from '../accounts/ProviderLogo';
import type { Provider, SourceRef } from '../accounts/types';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { hasMarketingRole, MarketingRole } from '../../../features/marketing/types';

/**
 * How many of the workspace's most recent posts we look through for an
 * account's recent activity.
 *
 * There is no per-account filter on `GET social-planner/posts` — the only
 * narrowing it offers is a `scheduledAt` window, a status and a page size — so
 * "the last few posts that went to THIS account" is one read of the workspace's
 * newest posts, filtered client-side by target. That makes the number a
 * HORIZON rather than a page size, and the empty state says so in as many
 * words: an account that has published nothing in the workspace's last fifty
 * posts is told exactly that, not that it has never published.
 *
 * Fifty rather than the endpoint's 200 maximum because this read fires the
 * first time anyone opens a popover and the payload carries every post's full
 * content and media list. Fifty covers a busy fortnight for a workspace
 * publishing to a handful of accounts, which is the span "son hareketler"
 * means.
 */
const RECENT_POST_HORIZON = 50;

/** How many of an account's own recent posts the popover lists. */
const RECENT_POSTS_SHOWN = 3;

/**
 * Hover-in is instant; hover-out waits this long.
 *
 * The delay is not polish, it is what makes the popover usable at all: it
 * carries a reconnect link and the provider's own error text, so the pointer
 * has to be able to travel from the trigger across the gap into the content
 * without the thing it is travelling to disappearing underneath it.
 */
const CLOSE_DELAY_MS = 140;

export interface ConnectedAccountsListProps {
  /** Window start, ISO instant — the stats band's range control owns it. */
  from: string;
  /** Window end, ISO instant, INCLUSIVE. */
  to: string;
  className?: string;
}

interface Identity {
  identityKey: string;
  displayName: string;
  provider: Provider;
  health: string;
  /** The SocialAccount rows behind this identity — usually one, never assumed. */
  socialAccountIds: string[];
}

/**
 * The connected accounts, as a list, beside the autopilot console.
 *
 * They used to be a wrapping row of chips INSIDE the stats panel, which put the
 * one permanent fact about this workspace — what it can publish to, and whether
 * those connections still work — inside a block that renders nothing at all
 * when the organic scopes have not been granted. The owner asked for the list
 * to sit next to the autopilot console instead, and to open its recent activity
 * on hover; both halves of that are the same instinct, that a connection is a
 * standing thing you check on rather than a caption under a chart.
 *
 * WHY THIS FIRES NO EXTRA REQUESTS. Two of its three reads are the ones
 * `AccountStatsPanel` already makes, under byte-identical keys — the Account
 * Center read model (`useConnections`) and the organic insights window
 * (`socialInsightsKey`). React Query serves the second mounter from the same
 * cache entry, so the list is free; a near-miss key here would double both
 * requests AND let the strip and the band disagree about the same account,
 * which is exactly the failure `socialQueryKeys` exists to prevent elsewhere.
 * That is also why the window arrives as props: the range control lives in the
 * stats band, and a window computed independently here would straddle UTC
 * midnight sooner or later and silently fork the cache.
 *
 * The third read — an account's recent posts — genuinely is new, and it is the
 * only one that is LAZY: nothing fetches it until the first popover opens.
 */
export function ConnectedAccountsList({ from, to, className }: ConnectedAccountsListProps) {
  const { t } = useTranslation('marketing');
  const role = useMarketingAuthStore((s) => s.user?.role);
  // `GET marketing/connections` and `GET social-planner/insights` are both
  // MANAGER-only. Firing either for a rep collects a 403 that main.tsx turns
  // into a toast on the front door — the same gate, for the same reason, as
  // AccountStatsPanel's.
  const isManager = hasMarketingRole(role, MarketingRole.MANAGER);

  const connections = useConnections({ enabled: isManager });
  const insights = useQuery({
    queryKey: socialInsightsKey({ from, to }),
    queryFn: () => getSocialInsights({ from, to }),
    enabled: isManager,
    meta: { silent: true },
  });

  /**
   * The recent-posts read is armed by the first popover that opens and then
   * stays armed.
   *
   * One query for the whole list rather than one per account: the endpoint
   * cannot filter by account anyway, so N popovers would make N identical
   * requests for the same fifty rows. Arming it on open — never on mount — is
   * what keeps a screen nobody hovers over from paying for it.
   */
  const [postsArmed, setPostsArmed] = useState(false);
  const posts = useQuery({
    // Built from the key the planner and the today rail already use, so the
    // `socialQueryKeys.posts` prefix invalidation they both fire after a
    // publish refreshes this list too.
    queryKey: [...socialQueryKeys.posts, 'recent', RECENT_POST_HORIZON] as const,
    queryFn: () => listSocialPosts({ limit: RECENT_POST_HORIZON }),
    enabled: postsArmed && isManager,
    meta: { silent: true },
  });

  const identities = useMemo<Identity[]>(
    () =>
      (connections.data?.providers ?? []).flatMap((p) =>
        p.connections.map((c) => ({
          identityKey: c.identityKey,
          displayName: c.displayName,
          provider: p.provider,
          health: c.health,
          socialAccountIds: (c.sources ?? [])
            .filter((s: SourceRef) => s.model === 'SocialAccount')
            .map((s: SourceRef) => s.id),
        })),
      ),
    [connections.data],
  );

  // Manager-only, and silent rather than apologetic: AccountStatsPanel's
  // coverage line already carries the one sentence a rep is owed about what
  // they cannot see, and repeating it in the top strip would spend the most
  // valuable row on the screen saying "not for you".
  if (!isManager) return null;

  const shell = (children: React.ReactNode) => (
    <Card
      data-testid="connected-accounts"
      className={cn('flex shrink-0 items-center overflow-hidden px-2 py-2', className)}
    >
      {children}
    </Card>
  );

  if (connections.isLoading) {
    return shell(
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-full" />
        ))}
      </div>,
    );
  }

  if (!identities.length) {
    /**
     * The empty state, compressed to one row and not one word less.
     *
     * It is the single most consequential state this component has — a
     * workspace with nothing connected can neither publish nor measure — so it
     * keeps the sentence and the CTA it had as a full EmptyState in the panel.
     * What it gives up is the illustration and the paragraph, which were
     * telling a workspace with no accounts about statistics it could not have
     * had either way.
     */
    return shell(
      <div className="flex items-center gap-2 px-1">
        <Plug className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-caption text-muted-foreground">
          {t('studio.accounts.none', 'Henüz bağlı hesap yok')}
        </span>
        <Button asChild size="sm" variant="secondary">
          <Link to="/accounts">{t('studio.accounts.connect', 'Hesap bağla')}</Link>
        </Button>
      </div>,
    );
  }

  return shell(
    <ul
      aria-label={t('studio.accounts.title', 'Bağlı hesaplar')}
      className="flex items-center gap-1.5 overflow-x-auto"
    >
      {identities.map((identity) => (
        <li key={identity.identityKey} className="shrink-0">
          <AccountItem
            identity={identity}
            insights={insights.data}
            insightsLoading={insights.isLoading}
            from={from}
            to={to}
            posts={posts.data}
            postsPending={posts.isPending}
            postsFailed={posts.isError && posts.data === undefined}
            onOpen={() => setPostsArmed(true)}
          />
        </li>
      ))}
    </ul>,
  );
}

/**
 * One account: the chip you see, and everything about it that you do not.
 *
 * HOVER OPENS, ACTIVATION TOGGLES. Hover is the affordance the owner asked for
 * and it is the one half of the population it does not serve: there is no hover
 * on a touchscreen and none on a keyboard. So the trigger is a real `<button>`
 * inside a Radix Popover — Enter, Space and a tap all open it, Escape and an
 * outside click close it — and the pointer path is an ADDITION on top of that,
 * gated on `pointerType === 'mouse'` so that the synthetic pointerenter a tap
 * fires cannot open the popover a fraction before the tap's click closes it
 * again.
 *
 * Focus deliberately does NOT open it. A hovercard normally opens on focus, but
 * this trigger toggles on activation, so a focus-opened popover would close on
 * the Enter that a keyboard user presses to open it — one behaviour has to give,
 * and the one that keeps the content reachable is activation.
 */
function AccountItem({
  identity,
  insights,
  insightsLoading,
  from,
  to,
  posts,
  postsPending,
  postsFailed,
  onOpen,
}: {
  identity: Identity;
  insights?: SocialInsightsResponse;
  insightsLoading: boolean;
  from: string;
  to: string;
  posts?: SocialPost[];
  postsPending: boolean;
  postsFailed: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The chip itself — the one element a dismissal may not be measured against. */
  const triggerRef = useRef<HTMLButtonElement>(null);
  /**
   * Is this popover a PREVIEW or has it been committed to?
   *
   * True while it is only being hovered, false once a click or an Enter has
   * pinned it. Two behaviours hang off the distinction, and both are the
   * difference between a preview and an interruption:
   *
   *  - A preview must not steal focus (`onOpenAutoFocus` is prevented), because
   *    the pointer is somewhere else entirely; a pinned one must take focus, or
   *    the reconnect link inside is unreachable by the keyboard that opened it.
   *  - A preview closes when the pointer leaves; a pinned one does not, because
   *    somebody asked for it and moving the mouse is not withdrawing the
   *    request. It closes on Escape or on a click outside, which is what Radix's
   *    dismiss layer already does.
   */
  const preview = useRef(false);

  const show = (viaHover: boolean) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (!open) {
      preview.current = viaHover;
      onOpen();
      setOpen(true);
    }
  };
  const hide = () => {
    if (!preview.current) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  const broken = identity.health === 'REAUTH_REQUIRED' || identity.health === 'DISABLED';
  const healthLabel = broken
    ? identity.health === 'REAUTH_REQUIRED'
      ? t('studio.accounts.reauth', 'Yeniden bağla')
      : t('studio.accounts.disabled', 'Kapalı')
    : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        if (next) {
          preview.current = false;
          onOpen();
          setOpen(true);
          return;
        }
        /**
         * A close request while the popover is still a PREVIEW is the trigger's
         * own click arriving a moment after the pointer opened it — the mouse
         * path is pointerenter, then click, and Radix's trigger toggles. Letting
         * that through would mean that clicking a popover you can already see
         * shuts it, so instead the click PINS what the hover previewed.
         *
         * It is only ever the trigger's click that lands here as a preview.
         * Radix dismisses on Escape and on an outside interaction through this
         * SAME callback, so both used to be swallowed too — and worse, the
         * swallow marked the popover pinned, so after an Escape the pointer
         * leaving no longer closed it either. Those two paths clear the flag
         * first (see PopoverContent below), which is what leaves this branch
         * meaning only what it says.
         */
        if (preview.current) {
          preview.current = false;
          return;
        }
        setOpen(false);
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="flex max-w-[12rem] items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-caption text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerEnter={(e) => e.pointerType === 'mouse' && show(true)}
          onPointerLeave={(e) => e.pointerType === 'mouse' && hide()}
        >
          <ProviderLogo provider={identity.provider} className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{identity.displayName}</span>
          {healthLabel && (
            <Badge tone="danger" size="sm">
              {healthLabel}
            </Badge>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-3"
        onOpenAutoFocus={(e) => {
          if (preview.current) e.preventDefault();
        }}
        /* A dismissal is a dismissal whether the popover was previewed or
           pinned, so both of these drop the preview flag and let the
           `onOpenChange` below take the ordinary close path. Radix already
           refuses to treat a pointerdown on the TRIGGER as an outside
           interaction, so clearing the flag here cannot swallow the click that
           is supposed to pin. */
        onEscapeKeyDown={() => {
          preview.current = false;
        }}
        onInteractOutside={(e) => {
          // Everything except the trigger. Radix reports the trigger's own
          // pointerdown as an "outside" interaction and only then refuses to
          // dismiss on it, so clearing the flag unconditionally here would hand
          // the click that follows an unpinned popover to close — the exact
          // gesture the pin exists for.
          if (triggerRef.current?.contains(e.target as Node)) return;
          preview.current = false;
        }}
        onPointerEnter={() => show(false)}
        onPointerLeave={hide}
      >
        <AccountActivity
          identity={identity}
          insights={insights}
          insightsLoading={insightsLoading}
          from={from}
          to={to}
          posts={posts}
          postsPending={postsPending}
          postsFailed={postsFailed}
          broken={broken}
        />
      </PopoverContent>
    </Popover>
  );
}

/** What the popover says, in the order the owner reads it. */
function AccountActivity({
  identity,
  insights,
  insightsLoading,
  from,
  to,
  posts,
  postsPending,
  postsFailed,
  broken,
}: {
  identity: Identity;
  insights?: SocialInsightsResponse;
  insightsLoading: boolean;
  from: string;
  to: string;
  posts?: SocialPost[];
  postsPending: boolean;
  postsFailed: boolean;
  broken: boolean;
}) {
  const { t, i18n } = useTranslation('marketing');
  const ids = identity.socialAccountIds;

  const rows = useMemo<OrganicAccountRow[]>(
    () => (insights?.byAccount ?? []).filter((r) => ids.includes(r.socialAccountId)),
    [insights?.byAccount, ids],
  );

  const labels = useMemo(() => dayRange(from, to), [from, to]);

  /**
   * This identity's follower level per day, CARRIED FORWARD.
   *
   * The same rule the stats band uses, for the same reason: a follower count is
   * a stock the account holds continuously and the sweep merely samples, so an
   * unsampled day is a gap (`null`, drawn as a break) and never a zero. Summed
   * across the identity's SocialAccount rows because a Meta identity can carry
   * both a Page and an IG business account under one externalId, and the person
   * hovering the chip thinks of that as one account.
   */
  const followerPoints = useMemo(() => {
    const byDate = new Map(insights?.followersByDay?.map((d) => [d.date, d.byAccount]) ?? []);
    const last = new Map<string, number>();
    return labels.map((day) => {
      const seen = byDate.get(day);
      for (const id of ids) {
        const v = seen?.[id];
        if (typeof v === 'number' && v > 0) last.set(id, v);
      }
      if (!last.size) return null;
      return [...last.values()].reduce((n, v) => n + v, 0);
    });
  }, [insights?.followersByDay, labels, ids]);

  const measured = followerPoints.filter((p): p is number => typeof p === 'number');
  const followersNow = measured.length ? measured[measured.length - 1] : null;
  const followerDelta = measured.length > 1 ? measured[measured.length - 1] - measured[0] : null;

  const window = rows.reduce(
    (acc, r) => ({
      reach: acc.reach + r.reach,
      engagements: acc.engagements + r.engagements,
      posts: acc.posts + r.posts,
    }),
    { reach: 0, engagements: 0, posts: 0 },
  );
  const error = rows.find((r) => r.insightsError)?.insightsError ?? null;

  /**
   * This account's slice of the workspace's recent posts, newest first.
   *
   * Ordered here rather than trusted from the wire: the unfiltered list is
   * documented as newest-first, but the field that matters to a reader is when
   * the post actually WENT OUT, and a scheduled-but-unpublished row has only a
   * `scheduledAt`. Sorting on the same value we then print keeps the list and
   * its timestamps telling one story.
   */
  const mine = useMemo(() => {
    const at = (p: SocialPost) => p.publishedAt ?? p.scheduledAt ?? p.createdAt;
    return (posts ?? [])
      .filter((p) => (p.targets ?? []).some((tg) => ids.includes(tg.socialAccountId)))
      .sort((a, b) => new Date(at(b)).getTime() - new Date(at(a)).getTime())
      .slice(0, RECENT_POSTS_SHOWN)
      .map((p) => ({
        post: p,
        at: at(p),
        // The TARGET's status, never the post's. `publishDuePost` marks a post
        // PUBLISHED as soon as ANY target succeeded, so reading post.status
        // here would report a green publish on the very account that failed.
        target: (p.targets ?? []).find((tg) => ids.includes(tg.socialAccountId)) ?? null,
      }));
  }, [posts, ids]);

  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  const statusLabel: Record<string, string> = {
    PUBLISHED: t('studio.accounts.postPublished', 'Yayınlandı'),
    PENDING: t('studio.accounts.postPending', 'Sırada'),
    FAILED: t('studio.accounts.postFailed', 'Başarısız'),
  };
  const statusTone: Record<string, 'success' | 'neutral' | 'danger'> = {
    PUBLISHED: 'success',
    PENDING: 'neutral',
    FAILED: 'danger',
  };

  return (
    <div className="space-y-3">
      <header className="flex items-center gap-2">
        <ProviderLogo provider={identity.provider} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {identity.displayName}
        </span>
        <Badge tone={broken ? 'danger' : 'success'} size="sm">
          {broken
            ? identity.health === 'REAUTH_REQUIRED'
              ? t('studio.accounts.reauth', 'Yeniden bağla')
              : t('studio.accounts.disabled', 'Kapalı')
            : t('studio.accounts.healthy', 'Çalışıyor')}
        </Badge>
      </header>

      {/* The way back to the account itself, on EVERY account rather than only
          a broken one. The chips used to be links to the Account Center; making
          them popover triggers took that route away from a healthy account,
          which is the one you open when you want to check a token's age or
          disconnect something — not only when it is already on fire. */}
      <Link
        to="/accounts"
        data-testid={`account-manage-${identity.identityKey}`}
        className="inline-flex items-center gap-1 text-caption text-primary hover:underline"
      >
        {t('studio.accounts.manage', 'Hesap merkezinde aç')}
      </Link>

      {/* (a) The health story, and it is only ever told with the provider's own
          words. A paraphrase would lose the one string that names the scope to
          go and ask for, and it is the string the owner can paste into a
          support thread. */}
      {(broken || error) && (
        <div className="space-y-1 rounded-md bg-danger-subtle p-2">
          {broken && (
            <p className="text-caption text-foreground">
              {identity.health === 'REAUTH_REQUIRED'
                ? t(
                    'studio.accounts.reauthWhy',
                    'Bu hesabın izni düştü — yeniden bağlanana kadar ne yayın çıkar ne istatistik gelir.',
                  )
                : t(
                    'studio.accounts.disabledWhy',
                    'Bu hesap kapalı — yayın kuyruğuna alınmıyor.',
                  )}
            </p>
          )}
          {error && <p className="text-micro text-muted-foreground">{error}</p>}
          <Link to="/accounts" className="text-caption font-medium text-primary hover:underline">
            {t('studio.accounts.reconnect', 'Hesap merkezinde düzelt')}
          </Link>
        </div>
      )}

      {/* (c) "Son hareketler" — the thing the owner asked for by name. It sits
          above the numbers because it is what a person hovers an account to
          find out, and it reserves its own height while it loads so the block
          below does not jump when the lazy read lands. */}
      <section className="space-y-1">
        <h4 className="text-micro font-medium uppercase tracking-wide text-muted-foreground">
          {t('studio.accounts.recent', 'Son hareketler')}
        </h4>
        {postsPending ? (
          <div className="space-y-1" data-testid="account-posts-loading">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : postsFailed ? (
          <p className="text-caption text-warning">
            {t('studio.accounts.postsUnread', 'Son hareketler okunamadı')}
          </p>
        ) : mine.length ? (
          <ul className="space-y-1">
            {mine.map(({ post, at, target }) => (
              <li key={post.id} className="flex items-start gap-1.5">
                <Badge tone={statusTone[target?.status ?? 'PENDING']} size="sm">
                  {statusLabel[target?.status ?? 'PENDING']}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-caption text-foreground">
                    {post.content || t('studio.accounts.noText', '(metinsiz gönderi)')}
                  </span>
                  <span className="block text-micro text-muted-foreground">{when(at)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          // Precisely scoped: we looked at the workspace's last N posts, not at
          // the whole history, and saying "this account has never published"
          // from that evidence would be a claim we cannot make.
          <p className="text-caption text-muted-foreground">
            {t(
              'studio.accounts.noRecent',
              'Son {{n}} gönderi arasında bu hesaba çıkan yok',
              { n: RECENT_POST_HORIZON },
            )}
          </p>
        )}
      </section>

      {/* (b) Followers now, the movement across the window, and the shape of it.
          A stock, so the movement is last-minus-first rather than a sum. */}
      <LineTrend
        labels={labels}
        series={[
          {
            key: 'followers',
            label: t('studio.accounts.followers', 'Takipçi'),
            points: followerPoints,
          },
        ]}
        title={t('studio.accounts.followers', 'Takipçi')}
        value={followersNow !== null ? compactNumber(followersNow, i18n.language) : '—'}
        caption={
          followerDelta !== null && followerDelta !== 0 ? (
            <span className={followerDelta > 0 ? 'text-success' : 'text-danger'}>
              {followerDelta > 0 ? '↑' : '↓'} {fullNumber(Math.abs(followerDelta), i18n.language)}
            </span>
          ) : undefined
        }
        isLoading={insightsLoading}
        emptyText={t('studio.accounts.noFollowers', 'Takipçi sayısı bildirilmedi')}
        height={52}
        ariaLabel={t('studio.accounts.followersAria', '{{name}} hesabının günlük takipçi sayısı', {
          name: identity.displayName,
        })}
        formatLabel={(d) =>
          new Date(`${d}T00:00:00Z`).toLocaleDateString(i18n.language, {
            day: 'numeric',
            month: 'short',
            timeZone: 'UTC',
          })
        }
        formatValue={(n) => fullNumber(n, i18n.language)}
      />

      {/* (d) The window's own numbers for this account. Not a chart: three
          levels with no shape worth drawing between them is a table, and the
          repo's chart primitives exist so that "not a chart" stays available as
          an answer. */}
      <dl className="grid grid-cols-3 gap-2 border-t border-border pt-2">
        <WindowStat
          label={t('studio.accounts.reach', 'Erişim')}
          value={compactNumber(window.reach, i18n.language)}
        />
        <WindowStat
          label={t('studio.accounts.engagements', 'Etkileşim')}
          value={compactNumber(window.engagements, i18n.language)}
        />
        <WindowStat
          label={t('studio.accounts.posts', 'Yayın')}
          value={fullNumber(window.posts, i18n.language)}
        />
      </dl>
      {!rows.length && (
        // No insights row at all for this identity — a messaging channel, an ad
        // account, a network with no organic API. The three zeros above would
        // otherwise read as a measured nothing.
        <p className="text-micro text-muted-foreground">
          {t(
            'studio.accounts.noOrganicRow',
            'Bu bağlantı için organik istatistik okunmuyor.',
          )}
        </p>
      )}
    </div>
  );
}

function WindowStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-micro uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

export default ConnectedAccountsList;
