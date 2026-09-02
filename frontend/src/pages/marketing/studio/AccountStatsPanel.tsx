import { useMemo, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { RefreshCw, AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { LineTrend, zeroFillNumeric, compactNumber, fullNumber } from '@/components/charts';
import {
  getSocialInsights,
  pullSocialInsights,
  socialInsightsKey,
  engagementRate,
  followersReported,
  totalFollowers,
  type SocialInsightsResponse,
} from '../../../features/marketing/api/socialInsights.service';
import { getAdMetrics, listAdAccounts } from '../../../features/marketing/api/ads.service';
import { useConnections, connectionsKey } from '../accounts/hooks';
import { NETWORK_META } from '../social/networks';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { hasMarketingRole, MarketingRole } from '../../../features/marketing/types';

/** The ranges the panel offers. Presets before a custom picker — nobody fights a calendar for "last 30 days". */
export const STUDIO_RANGES = [7, 30, 90] as const;
export type StudioRange = (typeof STUDIO_RANGES)[number];

/**
 * Three, and the owner said three: "3 tane istatistik alanı yeter şu an".
 *
 * It is also the number the band can hold at a size where each slot still
 * carries a number, a movement and a shape. A fourth would either shrink the
 * sparklines to decoration or push the band back into owning the screen, which
 * is the thing this rework exists to undo.
 */
const MAX_SLOTS = 3;

export interface AccountStatsPanelProps {
  /** The selected window, in days. Owned by the screen — see StudioOneScreen. */
  range: StudioRange;
  onRangeChange: (next: StudioRange) => void;
  /** Window start, ISO instant. */
  from: string;
  /** Window end, ISO instant, INCLUSIVE. */
  to: string;
}

/**
 * The Growth Studio's statistics band: the three numbers that matter right now.
 *
 * WHAT THIS REPLACED, AND WHY. It used to be four line charts, a stacked bar and
 * a coverage paragraph, holding the largest share of the screen — and standing
 * mostly empty, because organic insights depend on per-network scopes this
 * workspace does not hold until app review clears them. Area had been allocated
 * by how much CONTENT existed rather than by how much it MATTERED, so the
 * emptiest region was the biggest one. The band is now a defined height, and a
 * metric earns its slot rather than being reserved one.
 *
 * HOW THE THREE ARE CHOSEN. `CANDIDATES` below is a fixed list in descending
 * importance, written down once, in code. Selection is: walk it in order, keep
 * the first three that HAVE data. Two properties follow, and both are the point:
 *
 *  - A metric with nothing behind it never takes a slot. A tile reading "no
 *    organic data" is precisely the defect this rework answers; when fewer than
 *    three qualify, fewer are drawn and the missing ones are NAMED with their
 *    reason underneath, which is a fact rather than furniture.
 *  - The order can never depend on the values, so a poll cannot reshuffle it. A
 *    ranking by magnitude or by "biggest mover" would swap two tiles between two
 *    refreshes and make the band unreadable; here a slot changes only when a
 *    metric gains or loses its data entirely, which is a real event.
 *
 * The importance order itself answers one question: how close is this number to
 * the decision this screen exists to support — what do we publish next?
 *   1. Reach        — did what we published reach anyone at all.
 *   2. Engagement   — of the people it reached, did it land.
 *   3. Published    — did we actually put anything out. Counted from OUR OWN
 *                     targets table, so it is the one organic number that
 *                     survives a missing insights scope.
 *   4. Followers    — the asset that compounds, but a stock that barely moves
 *                     inside a 7-day window, so it loses to activity.
 *   5. Ad leads     — the paid lane's outcome.
 *   6. Ad spend     — the paid lane's cost, and the autopilot strip directly
 *                     above already reports the balance and this period's cap,
 *                     so it is the least likely of the six to be news.
 */
export default function AccountStatsPanel({
  range,
  onRangeChange,
  from,
  to,
}: AccountStatsPanelProps) {
  const { t, i18n } = useTranslation('marketing');
  const qc = useQueryClient();

  const role = useMarketingAuthStore((s) => s.user?.role);
  // The insights and connections endpoints are manager-only; ad metrics are not.
  // A rep who opens this page must get the half they are allowed to see and one
  // quiet sentence about the rest — not four failed requests and four toasts.
  const isManager = hasMarketingRole(role, MarketingRole.MANAGER);

  const insights = useQuery({
    queryKey: socialInsightsKey({ from, to }),
    queryFn: () => getSocialInsights({ from, to }),
    enabled: isManager,
    // This panel renders its own coverage/empty story; the global toaster would
    // only shout over it.
    meta: { silent: true },
  });

  const ads = useQuery({
    queryKey: ['marketing', 'ads', 'metrics', from, to],
    queryFn: () => getAdMetrics({ from: from.slice(0, 10), to: to.slice(0, 10) }),
    meta: { silent: true },
  });

  const adAccounts = useQuery({
    queryKey: ['marketing', 'ads', 'accounts'],
    queryFn: listAdAccounts,
    meta: { silent: true },
  });

  // `enabled: isManager` for the same reason as `insights` above, and it is the
  // one that was missing: `GET marketing/connections` is MANAGER-only, so a REP
  // landing here — including via a `/budget` bookmark, which App.tsx redirects
  // to `/studio` — fired it, collected a 403 and got a global "Forbidden" toast
  // on the front door. The panel's own promise three comments up is the half you
  // are allowed to see plus one quiet sentence, not a toast.
  const connections = useConnections({ enabled: isManager });

  const pull = useMutation({
    mutationFn: pullSocialInsights,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['marketing', 'social', 'insights'] });
      qc.invalidateQueries({ queryKey: connectionsKey });
      toast.success(
        r.errors > 0
          ? t('studio.stats.pulledWithErrors', '{{ok}} hesap güncellendi, {{bad}} tanesi okunamadı', {
              ok: r.accounts,
              bad: r.errors,
            })
          : t('studio.stats.pulled', 'Hesap istatistikleri güncellendi'),
      );
    },
    onError: (err: unknown) => {
      // 409 is not a failure. The backend takes a per-workspace lock on the
      // pull, so a second click — or a click that lands while the hourly sweep
      // is working this workspace — is told somebody is already doing it. An
      // error toast there would report a problem where the only thing that
      // happened is that the numbers are on their way.
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        toast.info(
          t('studio.stats.pullBusy', 'İstatistikler zaten güncelleniyor — birazdan hazır'),
        );
        return;
      }
      toast.error(t('studio.stats.pullFailed', 'İstatistikler güncellenemedi'));
    },
  });

  const data = insights.data;
  const days = useMemo(
    () =>
      zeroFillNumeric(data?.byDay, from, to, [
        'reach',
        'impressions',
        'engagements',
        'clicks',
        'videoViews',
        'posts',
      ] as const),
    [data?.byDay, from, to],
  );
  const labels = days.map((d) => d.date);

  const adDays = useMemo(
    () => zeroFillNumeric(ads.data?.byDay, from, to, ['spend', 'clicks', 'leads', 'impressions'] as const),
    [ads.data?.byDay, from, to],
  );

  /**
   * The currency, only when there is exactly one — and WHY there is not, when
   * there is not.
   *
   * `getMetrics` sums `AdMetric.spend` across every connected ad account and
   * returns one number with no currency attached — so a dollar Meta account and
   * a lira TikTok account produce a blended figure that is not money in any
   * currency at all. When the accounts disagree the number is still the best
   * summary available, but it must not be dressed in a symbol that claims a
   * conversion nobody performed.
   *
   * The reason is carried alongside the code because a bare `null` collapsed two
   * different situations into one silent outcome. `money()` falls back to an
   * unadorned grouped number whenever the code is null, and the only caption
   * that ever explained that fallback was gated on there being MORE THAN ONE ad
   * account — so a workspace whose `listAdAccounts` read failed, or whose single
   * account carries no currency string, saw its whole ad spend rendered as a
   * naked "12.480" under the heading "Reklam harcaması", with nothing anywhere
   * saying which money that is. Unknown and mixed are different admissions and
   * they get different sentences.
   */
  const currency = useMemo(() => {
    const set = new Set((adAccounts.data ?? []).map((a) => a.currency).filter(Boolean) as string[]);
    if (set.size === 1) return { code: [...set][0], reason: 'one' as const };
    return { code: null, reason: set.size > 1 ? ('mixed' as const) : ('unknown' as const) };
  }, [adAccounts.data]);

  const money = (n: number) =>
    currency.code
      ? new Intl.NumberFormat(i18n.language, {
          style: 'currency',
          currency: currency.code,
          maximumFractionDigits: 0,
        }).format(n)
      : fullNumber(n, i18n.language);

  const num = (n: number) => fullNumber(n, i18n.language);
  const short = (n: number) => compactNumber(n, i18n.language);
  const dayLabel = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(i18n.language, {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });

  /**
   * The workspace's follower level per day, CARRIED FORWARD across the days
   * nobody measured.
   *
   * Every other series here is a flow — impressions that happened on a day, or
   * did not — so an unmeasured day is honestly zero and `zeroFillNumeric` is
   * right. A follower count is a STOCK: it is a level the account holds
   * continuously, and the sweep merely samples it. Zero-filling a stock draws
   * the audience collapsing to nothing every time the pull was skipped or rate
   * limited, and then leaping back — a sawtooth that is entirely an artefact of
   * our own sampling and reads as catastrophe. So a gap holds the last observed
   * level, and the line simply does not start until the first real reading.
   *
   * ONE LINE, not five. This used to be a line per account, which was the right
   * picture at a quarter of the panel and is unreadable at a third of a band —
   * five strokes and a legend inside 56 pixels. "Which account" is a question
   * you ask about a specific account, so it moved to that account's popover in
   * the top strip; what belongs here is the workspace's level and its direction.
   */
  const followerPoints = useMemo(() => {
    const ids = followersReported(data?.byAccount ?? []).map((a) => a.socialAccountId);
    const byDate = new Map(data?.followersByDay?.map((d) => [d.date, d.byAccount]) ?? []);
    const last = new Map<string, number>();
    return labels.map((d) => {
      const seen = byDate.get(d);
      for (const id of ids) {
        const v = seen?.[id];
        if (typeof v === 'number' && v > 0) last.set(id, v);
      }
      // `null`, not 0, before the first reading: the days before we first
      // sampled are days whose count we do not know, and drawing them on the
      // axis shows an audience appearing out of nothing on the day our sweep
      // happened to start.
      if (!last.size) return null;
      return [...last.values()].reduce((n, v) => n + v, 0);
    });
  }, [data?.byAccount, data?.followersByDay, labels]);

  const totals = data?.totals;
  const erate = totals ? engagementRate(totals) : null;
  const accountRows = data?.byAccount ?? [];
  const followers = totalFollowers(accountRows);
  /**
   * How many accounts actually reported a follower count, out of how many we
   * asked about. The headline is a SUM over the accounts that answered, and when
   * only some did, that sum is the audience of a subset presented as the
   * audience of the workspace.
   */
  const reported = followersReported(accountRows).length;
  const followersPartial = followers !== null && reported < accountRows.length;

  /**
   * The one sentence that keeps the spend headline honest, or nothing.
   *
   * Attached to a FIGURE, so it only appears when there is one: an unqualified
   * "0" claims no money and needs no disclaimer, and a permanent footnote under
   * an empty chart is noise that teaches people to stop reading footnotes.
   */
  const spendCaveat =
    (ads.data?.totals.spend ?? 0) > 0 && currency.reason !== 'one'
      ? currency.reason === 'mixed'
        ? t(
            'studio.stats.mixedCurrency',
            'Reklam hesapları farklı para birimlerinde — toplam dönüştürülmedi',
          )
        : t(
            'studio.stats.unknownCurrency',
            'Para birimi okunamadı — tutar birimsiz gösteriliyor',
          )
      : undefined;

  const identities = useMemo(
    () =>
      (connections.data?.providers ?? []).flatMap((p) =>
        p.connections.map((c) => ({ ...c, provider: p.provider })),
      ),
    [connections.data],
  );

  const loading = insights.isLoading || ads.isLoading;

  /**
   * "We could not read this", which is NOT "there is nothing here".
   *
   * Both reads zero-fill their window before they resolve, so a failed one hands
   * every series a flat run of zeros — which would then be indistinguishable
   * from a measured nothing, and would silently disqualify every metric behind
   * that read from taking a slot for the RIGHT reason. `data === undefined` and
   * not the bare error flag, the same rule the Autopilot strip and the wallet
   * tile use: React Query keeps the last good response and only flips status
   * when a BACKGROUND refetch fails, and numbers we still hold are worth more
   * than an apology.
   */
  const organicUnread = insights.isError && insights.data === undefined;
  const adsUnread = ads.isError && ads.data === undefined;

  const noOrganic = organicUnread
    ? t('studio.stats.organicUnread', 'Hesap istatistikleri okunamadı')
    : t('studio.stats.reasonNoOrganic', 'organik veri yok');
  const noAds = adsUnread
    ? t('studio.stats.adsUnread', 'Reklam verileri okunamadı')
    : t('studio.stats.reasonNoAds', 'reklam verisi yok');

  const sum = (ns: number[]) => ns.reduce((n, v) => n + v, 0);

  /**
   * Every metric this band knows how to draw, in descending importance. The
   * order is the ranking — see the component's doc block for the argument
   * behind it — and it is deliberately a constant shape rather than something
   * derived from the numbers, so that a refresh can never reorder the tiles.
   */
  const candidates: Candidate[] = [
    {
      key: 'reach',
      organic: true,
      title: t('studio.stats.reach', 'Erişim'),
      hasData: !organicUnread && sum(days.map((d) => d.reach)) > 0,
      noDataReason: noOrganic,
      value: totals ? short(totals.reach) : '—',
      points: days.map((d) => d.reach),
      kind: 'flow',
      format: num,
      ariaLabel: t('studio.stats.reachAria', 'Günlük organik erişim'),
    },
    {
      key: 'engagements',
      organic: true,
      title: t('studio.stats.engagements', 'Etkileşim'),
      hasData: !organicUnread && sum(days.map((d) => d.engagements)) > 0,
      noDataReason: noOrganic,
      // The RATE when there are impressions to divide by, the count otherwise.
      // "0%" and "nobody has seen it yet" are different facts.
      value: erate !== null ? `${erate.toFixed(1)}%` : totals ? short(totals.engagements) : '—',
      caption: erate !== null ? t('studio.stats.erateCaption', 'etkileşim / gösterim') : undefined,
      points: days.map((d) => d.engagements),
      kind: 'flow',
      format: num,
      ariaLabel: t('studio.stats.engAria', 'Günlük organik etkileşim'),
    },
    {
      key: 'published',
      organic: true,
      title: t('studio.stats.publishedTitle', 'Yayınlanan içerik'),
      hasData: !organicUnread && (totals?.posts ?? 0) > 0,
      noDataReason: organicUnread
        ? noOrganic
        : t('studio.stats.reasonNoPublished', 'bu aralıkta yayın yok'),
      value: totals ? num(totals.posts) : '—',
      caption: t('studio.stats.publishedCaption', 'Kaç içerik çıktı — kaç kişiye ulaştığı değil.'),
      points: days.map((d) => d.posts),
      kind: 'flow',
      format: num,
      ariaLabel: t('studio.stats.publishedAria', 'Gün başına yayınlanan içerik sayısı'),
    },
    {
      key: 'followers',
      organic: true,
      title: t('studio.stats.followers', 'Takipçi'),
      hasData: !organicUnread && followers !== null,
      noDataReason: organicUnread
        ? noOrganic
        : t('studio.stats.reasonNoFollowers', 'takipçi sayısı bildirilmedi'),
      value: followers !== null ? short(followers) : '—',
      // A new key rather than the panel's old `followersPartial`: that one is a
      // full sentence and this slot has a third of a band to say it in. Same
      // fact, different room. The comment sits ABOVE the call and not inside
      // it because `studioSurfaceKeys.test.ts` matches `t(` immediately
      // followed by its key — a comment in between hides the key from the very
      // guard that exists to stop an untranslated string shipping.
      caption: followersPartial
        ? t('studio.stats.followersPartialShort', '{{n}} hesabın {{k}} tanesi bildirdi', {
            n: accountRows.length,
            k: reported,
          })
        : undefined,
      points: followerPoints,
      kind: 'stock',
      format: num,
      // A new key, because the picture changed: the old `followersAria`
      // described a line per account, and this slot draws the workspace's
      // total. Reusing it would leave the catalogue narrating a chart that
      // no longer exists, to exactly the readers who cannot see it.
      ariaLabel: t('studio.stats.followersTotalAria', 'Günlük toplam takipçi sayısı'),
    },
    {
      key: 'leads',
      organic: false,
      title: t('studio.stats.leads', 'Reklamdan gelen kayıt'),
      hasData: !adsUnread && (ads.data?.totals.leads ?? 0) > 0,
      noDataReason: noAds,
      value: ads.data ? num(ads.data.totals.leads) : '—',
      points: adDays.map((d) => d.leads),
      kind: 'flow',
      format: num,
      ariaLabel: t('studio.stats.leadsAria', 'Günlük reklam kaydı'),
    },
    {
      key: 'spend',
      organic: false,
      title: t('studio.stats.spend', 'Reklam harcaması'),
      hasData: !adsUnread && (ads.data?.totals.spend ?? 0) > 0,
      noDataReason: noAds,
      value: ads.data ? money(ads.data.totals.spend) : '—',
      caption: spendCaveat,
      points: adDays.map((d) => d.spend),
      kind: 'flow',
      format: money,
      ariaLabel: t('studio.stats.spendAria', 'Günlük reklam harcaması'),
    },
  ];

  const shown = candidates.filter((c) => c.hasData).slice(0, MAX_SLOTS);

  /**
   * The metrics that WOULD have been on screen and are not.
   *
   * Cut at the rank of the last slot: a candidate that lost to three better ones
   * lost on merit, and listing it would be noise. A candidate that outranks
   * something on screen — or that would have filled an empty slot — lost because
   * we cannot see it, and that is a fact the owner needs, because it is the
   * difference between "we did badly there" and "we cannot see there".
   */
  const cutoff = shown.length === MAX_SLOTS ? candidates.indexOf(shown[MAX_SLOTS - 1]) : candidates.length;
  const missing = candidates.filter((c, i) => !c.hasData && i < cutoff && (isManager || !c.organic));

  /**
   * The missing metrics, GROUPED BY REASON.
   *
   * One line has to hold up to five of them, and "Erişim (organik veri yok) ·
   * Etkileşim (organik veri yok) · Takipçi (organik veri yok)" spends most of
   * its width repeating one fact. Grouping keeps every metric NAMED — which is
   * the whole value of the line — while making it short enough that nothing has
   * to be capped away. Capping was the alternative and it was worse: it dropped
   * whichever reasons sorted last, and the reason that sorts last is the ad
   * half, so a failed ad read could vanish behind three absent organic ones.
   */
  const missingByReason = missing.reduce<{ reason: string; titles: string[] }[]>((groups, c) => {
    const g = groups.find((x) => x.reason === c.noDataReason);
    if (g) g.titles.push(c.title);
    else groups.push({ reason: c.noDataReason, titles: [c.title] });
    return groups;
  }, []);

  /**
   * Nothing is connected at all — no social account, no ad account.
   *
   * Six metrics all correctly reporting "no data" is a true statement made six
   * times, and the useful version of it is one sentence. The connect CTA is NOT
   * repeated here: it lives in the connected-accounts list at the top of the
   * screen, where it is one row from the thing it is about, and two buttons
   * offering the same route is how a screen stops being read.
   */
  const nothingConnected =
    // Manager-gated, because for a rep `identities.length === 0` is not a fact
    // about the workspace: the connections query is `enabled: isManager`, so
    // the length is zero by construction and the sentence would be invented.
    isManager &&
    !connections.isLoading &&
    !adAccounts.isLoading &&
    identities.length === 0 &&
    (adAccounts.data?.length ?? 0) === 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          {t('studio.stats.bandTitle', 'Öne çıkan istatistikler')}
        </h2>
        {/* Filters in ONE row above everything they scope, never per-slot:
            every number below re-renders against the same slice, so two slots
            can never be read against different windows. */}
        <div className="flex items-center gap-1.5">
          <SegmentedControl
            aria-label={t('studio.stats.rangeLabel', 'Zaman aralığı')}
            value={String(range)}
            onChange={(v) => onRangeChange(Number(v) as StudioRange)}
            options={STUDIO_RANGES.map((d) => ({
              value: String(d),
              label: t('studio.stats.range', '{{d}} gün', { d }),
            }))}
          />
          {isManager && (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={t('studio.stats.refresh', 'İstatistikleri yenile')}
              disabled={pull.isPending}
              onClick={() => pull.mutate()}
            >
              <RefreshCw className={`h-4 w-4 ${pull.isPending ? 'animate-spin' : ''}`} />
            </IconButton>
          )}
        </div>
      </header>

      {/* `overflow-y-auto` as the safety valve, not as the plan: the band is a
          fixed height and the slots are sized to fit it, but a caption only
          some states carry (a currency caveat, a partial-coverage note) can
          add a line. Scrolling a slot is survivable; spilling it out of the
          card over the ideas below is not. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[104px] w-full rounded-lg" />
            ))}
          </div>
        ) : nothingConnected ? (
          <p className="text-caption text-muted-foreground">
            {t(
              'studio.stats.nothingConnected',
              'Bağlı hesap yok — bir hesap bağlandığı anda buradaki sayılar dolmaya başlar.',
            )}
          </p>
        ) : shown.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="stat-slots">
            {shown.map((c) => (
              <StatSlot key={c.key} candidate={c} labels={labels} formatLabel={dayLabel} />
            ))}
          </div>
        ) : (
          <p className="text-caption text-muted-foreground">
            {t(
              'studio.stats.noneAtAll',
              'Bu aralıkta gösterilebilecek bir istatistik yok.',
            )}
          </p>
        )}
      </div>

      <footer className="shrink-0 space-y-0.5">
        {!nothingConnected && missing.length > 0 && (
          <p
            role="status"
            data-testid="stats-missing"
            className="line-clamp-1 text-micro text-muted-foreground"
          >
            {t('studio.stats.missing', 'Gösterilemeyen')}:{' '}
            {missingByReason.map((g) => `${g.titles.join(', ')} (${g.reason})`).join(' · ')}
          </p>
        )}
        <CoverageNote
          coverage={data?.coverage}
          accounts={data?.byAccount}
          canSee={isManager}
        />
      </footer>
    </div>
  );
}

/** One metric that earned a slot: what it is, the number, its movement, its shape. */
interface Candidate {
  key: string;
  title: string;
  hasData: boolean;
  /**
   * Does this metric come from the manager-only insights read? A rep never
   * fires it, so naming it as "missing" would report a blind spot that is
   * really a permission — the coverage line says that once, properly.
   */
  organic: boolean;
  /** Why it has none, phrased to sit inside "Erişim (…)". */
  noDataReason: string;
  value: string;
  caption?: ReactNode;
  points: (number | null)[];
  /**
   * FLOW sums over days (reach, posts, spend); STOCK is a level sampled on them
   * (followers). The distinction decides what "movement" even means, so it is
   * declared rather than guessed from the numbers.
   */
  kind: 'flow' | 'stock';
  format: (n: number) => string;
  ariaLabel: string;
}

function StatSlot({
  candidate,
  labels,
  formatLabel,
}: {
  candidate: Candidate;
  labels: string[];
  formatLabel: (d: string) => string;
}) {
  const { t } = useTranslation('marketing');
  const move = movement(candidate);

  return (
    <div data-testid={`stat-slot-${candidate.key}`} className="min-w-0">
      <LineTrend
        labels={labels}
        series={[{ key: candidate.key, label: candidate.title, points: candidate.points }]}
        title={candidate.title}
        value={candidate.value}
        action={
          move ? (
            <span
              data-testid={`stat-move-${candidate.key}`}
              data-direction={move.direction}
              title={
                candidate.kind === 'stock'
                  ? t('studio.stats.moveStock', 'aralığın başına göre')
                  : t('studio.stats.moveFlow', 'önceki {{d}} güne göre', { d: move.span })
              }
              className={
                move.direction === 'up'
                  ? 'text-caption font-medium text-success'
                  : move.direction === 'down'
                    ? 'text-caption font-medium text-danger'
                    : 'text-caption font-medium text-muted-foreground'
              }
            >
              {move.direction === 'up' ? '↑' : move.direction === 'down' ? '↓' : '→'}{' '}
              {move.pct !== null
                ? `%${Math.abs(move.pct).toFixed(0)}`
                : candidate.format(Math.abs(move.delta))}
            </span>
          ) : undefined
        }
        caption={candidate.caption}
        height={56}
        /* A slot is only here because its HEADLINE has data, which is not the
           same as having a daily shape: an account can report a follower level
           with no per-day rows behind it. So the empty state talks about the
           missing TREND and never contradicts the number printed above it. */
        emptyText={t('studio.stats.noTrend', 'günlük seyir yok')}
        ariaLabel={candidate.ariaLabel}
        formatLabel={formatLabel}
        formatValue={(n) => candidate.format(n)}
      />
    </div>
  );
}

/**
 * How the metric moved across the window.
 *
 * A FLOW is compared half against half: the last `floor(n/2)` days against the
 * first `floor(n/2)`, dropping the middle day on an odd window so that the two
 * sides are the same length. Unequal halves would put a spurious ±1 day of
 * volume into every comparison, and on a 7-day window that is a seventh of the
 * answer. Nothing is compared against a PRECEDING window, which would need a
 * second request and a second cache entry for a number the reader already has
 * the shape of in front of them.
 *
 * A STOCK is simply last-measured minus first-measured; summing a level across
 * days would be meaningless.
 *
 * `pct` is null when the base is zero. Growth from nothing is not a percentage
 * — every such move is "+∞%" — so the absolute change is shown instead.
 */
function movement(c: Candidate): {
  direction: 'up' | 'down' | 'flat';
  delta: number;
  pct: number | null;
  span: number;
} | null {
  if (c.kind === 'stock') {
    const measured = c.points.filter((p): p is number => typeof p === 'number');
    if (measured.length < 2) return null;
    const delta = measured[measured.length - 1] - measured[0];
    const base = measured[0];
    return {
      direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      delta,
      pct: base > 0 ? (delta / base) * 100 : null,
      span: measured.length,
    };
  }

  const nums = c.points.map((p) => (typeof p === 'number' ? p : 0));
  const half = Math.floor(nums.length / 2);
  if (half < 1) return null;
  const add = (ns: number[]) => ns.reduce((n, v) => n + v, 0);
  const first = add(nums.slice(0, half));
  const second = add(nums.slice(nums.length - half));
  const delta = second - first;
  return {
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
    delta,
    pct: first > 0 ? (delta / first) * 100 : null,
    span: half,
  };
}

/**
 * What the numbers above do NOT cover — one line, with the detail one click away.
 *
 * This is the line that keeps the band honest. Organic insights need a
 * per-network permission the workspace may never have been granted, and when a
 * network cannot be read its posts contribute nothing — which looks exactly like
 * posting nothing. Naming the network is the difference between "we are doing
 * badly there" and "we cannot see there", and only one of those is a reason to
 * change what you publish.
 *
 * It used to be a paragraph in the middle of the screen: a warning block per
 * unreadable network, a bulleted list of failing accounts with the provider's
 * verbatim error under each, a partial-coverage count and a freshness stamp —
 * permanently, on a surface whose most valuable rows belong to the work. None of
 * those facts is dropped. They moved behind a disclosure whose TRIGGER states
 * the headline, so the existence of a blind spot is on the screen at all times
 * and only its detail costs a click.
 *
 * TWO KINDS OF BLIND SPOT, KEPT APART. `unsupportedNetworks` is permanent —
 * there is no API to call, however the grant is fixed. A per-account
 * `insightsError` is the opposite: we asked, we were refused, and the refusal
 * has a reason and often a fix. Folding them into one warning would tell the
 * owner nothing can be done about a problem that can.
 */
function CoverageNote({
  coverage,
  accounts,
  canSee,
}: {
  coverage?: SocialInsightsResponse['coverage'];
  accounts?: SocialInsightsResponse['byAccount'];
  canSee: boolean;
}) {
  const { t, i18n } = useTranslation('marketing');

  if (!canSee) {
    return (
      <p className="text-micro text-muted-foreground">
        {t(
          'studio.stats.managerOnly',
          'Hesap istatistiklerini yalnızca yöneticiler görebilir. Reklam grafikleri herkese açık.',
        )}
      </p>
    );
  }
  if (!coverage) return null;

  const unread = coverage.unsupportedNetworks ?? [];
  // Named from byAccount rather than counted from coverage: a count tells the
  // owner that something is wrong somewhere, which is the least actionable
  // possible version of the truth.
  const failing = (accounts ?? []).filter((a) => Boolean(a.insightsError));
  const shown = failing.slice(0, 3);
  const partial = coverage.accountsWithData < coverage.accounts;
  const stale = coverage.lastPulledAt
    ? new Date(coverage.lastPulledAt).toLocaleString(i18n.language, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  const blind = unread.length > 0 || failing.length > 0;
  const headline = blind
    ? t('studio.stats.blindSpots', '{{n}} kaynak okunamıyor — sayılar onları kapsamıyor', {
        n: unread.length + failing.length,
      })
    : partial
      ? t('studio.stats.partial', '{{n}} hesabın {{k}} tanesinden veri geldi', {
          n: coverage.accounts,
          k: coverage.accountsWithData,
        })
      : stale
        ? t('studio.stats.lastPulled', 'Son güncelleme: {{when}}', { when: stale })
        : t('studio.stats.neverPulled', 'İstatistikler henüz bir kez bile çekilmedi');

  return (
    <div className="flex items-center gap-1.5">
      {blind && <AlertTriangle className="h-3 w-3 shrink-0 text-warning" aria-hidden="true" />}
      <p
        role="status"
        className={`min-w-0 flex-1 truncate text-micro ${blind ? 'text-warning' : 'text-muted-foreground'}`}
      >
        {headline}
      </p>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-5 shrink-0 px-1.5 text-micro">
            <Info className="me-1 h-3 w-3" aria-hidden="true" />
            {t('studio.stats.coverageDetail', 'Kapsam')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 space-y-2 p-3">
          {unread.length > 0 && (
            <p className="text-caption text-warning">
              {t('studio.stats.unreadable', 'Okunamayan ağlar')}:{' '}
              {unread
                .map((n) => NETWORK_META[n as keyof typeof NETWORK_META]?.label ?? n)
                .join(', ')}{' '}
              —{' '}
              {t(
                'studio.stats.unreadableHint',
                'buraya yayın yapabiliyoruz ama istatistiklerini okuyamıyoruz, yukarıdaki sayılara dahil değiller',
              )}
            </p>
          )}
          {shown.length > 0 && (
            <div className="text-caption text-warning">
              <span>{t('studio.stats.readFailed', 'Okunamayan hesaplar')}:</span>
              <ul className="mt-0.5 space-y-0.5">
                {shown.map((a) => (
                  <li key={a.socialAccountId}>
                    <span className="font-medium">{a.displayName}</span>
                    {' — '}
                    {/* The provider's own message, verbatim. A paraphrase would
                        lose the one string that tells a developer which scope to
                        request, and the owner can paste it into a support note. */}
                    <span className="text-muted-foreground">{a.insightsError}</span>
                  </li>
                ))}
              </ul>
              {failing.length > shown.length && (
                <span className="text-muted-foreground">
                  {t('studio.stats.readFailedMore', 've {{n}} hesap daha', {
                    n: failing.length - shown.length,
                  })}
                </span>
              )}
            </div>
          )}
          {partial && (
            <p className="text-caption text-muted-foreground">
              {t('studio.stats.partial', '{{n}} hesabın {{k}} tanesinden veri geldi', {
                n: coverage.accounts,
                k: coverage.accountsWithData,
              })}
            </p>
          )}
          <p className="text-caption text-muted-foreground">
            {stale
              ? t('studio.stats.lastPulled', 'Son güncelleme: {{when}}', { when: stale })
              : t('studio.stats.neverPulled', 'İstatistikler henüz bir kez bile çekilmedi')}
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}
