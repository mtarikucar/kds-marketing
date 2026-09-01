import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Plug, RefreshCw, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { LineTrend, StackedBars, zeroFillNumeric, compactNumber, fullNumber } from '@/components/charts';
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
import { ProviderLogo } from '../accounts/ProviderLogo';
import { NETWORK_META } from '../social/networks';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { hasMarketingRole, MarketingRole } from '../../../features/marketing/types';
import { trailingUtcDays } from './todayBounds';

/** The ranges the panel offers. Presets before a custom picker — nobody fights a calendar for "last 30 days". */
const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

/**
 * The Growth Studio's top-left panel: how the connected accounts are actually
 * doing.
 *
 * Read this as SMALL MULTIPLES rather than as a dashboard of unrelated tiles.
 * Reach, engagement, followers and ad spend share one x-axis and each keeps its
 * own y-scale, which is the only honest way to show them together: they differ
 * by orders of magnitude, and putting two of them on one plot with two scales
 * would invent a correlation out of where the two axes happened to be pinned.
 * Four small charts answer "what is the shape of each" without ever implying a
 * relationship the data does not contain.
 *
 * The panel also refuses to draw a chart it cannot back. Organic insights depend
 * on per-network permissions this workspace may simply not hold, and a flat zero
 * line is indistinguishable from a real zero — so an unreadable network is named
 * in words instead of being averaged into silence, and so is each account whose
 * last pull was refused, with the provider's own reason next to it.
 */
export default function AccountStatsPanel() {
  const { t, i18n } = useTranslation('marketing');
  const qc = useQueryClient();
  const [range, setRange] = useState<Range>(30);

  const role = useMarketingAuthStore((s) => s.user?.role);
  // The insights and connections endpoints are manager-only; ad metrics are not.
  // A rep who opens this page must get the half they are allowed to see and one
  // quiet sentence about the rest — not four failed requests and four toasts.
  const isManager = hasMarketingRole(role, MarketingRole.MANAGER);

  // UTC days, not the workspace's — see trailingUtcDays. Metric rows are stored
  // against a UTC `@db.Date`, so a zoned window over them straddles an extra
  // bucket at each edge and "30 gün" draws 31 partial columns.
  const { from, to } = useMemo(() => trailingUtcDays(range), [range]);

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
   * Followers, per account, CARRIED FORWARD across the days nobody measured.
   *
   * Every other series here is a flow — impressions that happened on a day, or
   * did not — so an unmeasured day is honestly zero and `zeroFillNumeric` is
   * right. A follower count is a STOCK: it is a level the account holds
   * continuously, and the sweep merely samples it. Zero-filling a stock draws
   * the audience collapsing to nothing every time the pull was skipped or rate
   * limited, and then leaping back — a sawtooth that is entirely an artefact of
   * our own sampling and reads as catastrophe.
   *
   * So a gap holds the last observed level, and the line simply does not start
   * until the first real reading. Only accounts that actually reported a count
   * get a line at all: the backend uses 0 for "never read", which is
   * indistinguishable from a real zero, and inventing a flat line along the axis
   * for an account we cannot measure is exactly the fabrication the coverage
   * note exists to prevent.
   *
   * Capped at the number of identity colours. A sixth account would either cycle
   * a hue — making two accounts look like one — or fold into a muted "other"
   * line, which is meaningless for a count that belongs to somebody.
   */
  const followerSeries = useMemo(() => {
    const accounts = (data?.byAccount ?? []).filter((a) => (a.followers ?? 0) > 0).slice(0, 5);
    const byDate = new Map(data?.followersByDay?.map((d) => [d.date, d.byAccount]) ?? []);
    return accounts.map((a) => {
      let last: number | null = null;
      return {
        key: a.socialAccountId,
        label: a.displayName,
        // `null` before the first reading, the carried level after it. Null is
        // a GAP in the plot, not a zero — the days before we first sampled an
        // account are days whose follower count we do not know, and drawing
        // them on the axis would show an audience appearing out of nothing on
        // the day our sweep happened to start.
        points: labels.map((d) => {
          const seen = byDate.get(d)?.[a.socialAccountId];
          if (typeof seen === 'number') last = seen;
          return last;
        }),
      };
    });
  }, [data?.byAccount, data?.followersByDay, labels]);

  /**
   * What we published each day, split by network.
   *
   * The read model reports a day's `posts` total and each network's `byNetwork`
   * total, and — when the backend supplies it — the per-day network split. When
   * it does not, the columns collapse to one undifferentiated "yayınlanan"
   * series rather than apportioning the network totals across days by some
   * plausible-looking rule: a stack invented that way would be a guess drawn at
   * the same weight as measured data, which is the one thing a chart may not do.
   */
  const publishSeries = useMemo(() => {
    const nets = Object.keys(data?.byNetwork ?? {});
    const hasSplit = (data?.byDay ?? []).some((d) => d.byNetwork);
    if (!nets.length || !hasSplit) {
      return [
        {
          key: 'all',
          label: t('studio.stats.published', 'Yayınlanan'),
          values: days.map((d) => d.posts),
        },
      ];
    }
    const byDate = new Map((data?.byDay ?? []).map((d) => [d.date, d.byNetwork ?? {}]));
    return nets.slice(0, 5).map((net) => ({
      key: net,
      label: NETWORK_META[net as keyof typeof NETWORK_META]?.label ?? net,
      values: labels.map((d) => byDate.get(d)?.[net] ?? 0),
    }));
  }, [data?.byNetwork, data?.byDay, days, labels, t]);

  const totals = data?.totals;
  const erate = totals ? engagementRate(totals) : null;
  const accountRows = data?.byAccount ?? [];
  const followers = totalFollowers(accountRows);
  /**
   * How many accounts actually reported a follower count, out of how many we
   * asked about.
   *
   * The headline is a SUM over the accounts that answered, and when only some
   * did, that sum is the audience of a subset presented as the audience of the
   * workspace. Nothing else on the panel covers it: the coverage note below
   * speaks about insights — impressions, reach, engagement — and an account can
   * perfectly well report those while its follower field stays at the backend's
   * "never read" zero. So the gap is named next to the number it qualifies.
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
   * Both reads zero-fill their window before they resolve, so a failed one
   * hands every chart a flat run of zeros — which each chart correctly refuses
   * to plot, and then labels with its empty state. The empty states say
   * "Organik veri yok" and "Reklam verisi yok": flat assertions about the
   * business, made on the strength of a request that never came back. Both
   * queries are `meta: { silent: true }`, so nothing else on the screen
   * mentions the failure either — a panel whose entire purpose is refusing to
   * state what it does not know was, in its most common failure mode, stating
   * exactly that four times over.
   *
   * `data === undefined` and not the bare error flag, the same rule the
   * Autopilot strip and the wallet tile use: React Query keeps the last good
   * response and only flips status when a BACKGROUND refetch fails, and numbers
   * we still hold are worth more than an apology.
   */
  const organicUnread = insights.isError && insights.data === undefined;
  const adsUnread = ads.isError && ads.data === undefined;
  const organicEmptyText = organicUnread
    ? t('studio.stats.organicUnread', 'Hesap istatistikleri okunamadı')
    : undefined;

  /**
   * Nothing is connected at all — no social account, no ad account.
   *
   * In that state the five charts below are not "empty", they are meaningless:
   * five boxes of zeros and four headline dashes, which is a great deal of
   * furniture arranged around the absence of a single decision. Worse, a wall of
   * zeros reads as a RESULT — as though the accounts were connected and doing
   * nothing — which is the one thing this panel is built not to say.
   *
   * So a workspace at zero gets one sentence and one button instead. The charts
   * come back the moment there is anything at all to plot, and the ad half is
   * included in the test because an ad account with no social account still has
   * a real spend series worth drawing.
   */
  const nothingConnected =
    !connections.isLoading &&
    !adAccounts.isLoading &&
    identities.length === 0 &&
    (adAccounts.data?.length ?? 0) === 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          {t('studio.stats.title', 'Bağlı hesaplar')}
        </h2>
        {/* Filters in ONE row above everything they scope, never per-chart:
            every number below re-renders against the same slice, so the charts
            can never be read against different windows. */}
        <div className="flex items-center gap-1.5">
          <SegmentedControl
            aria-label={t('studio.stats.rangeLabel', 'Zaman aralığı')}
            value={String(range)}
            onChange={(v) => setRange(Number(v) as Range)}
            options={RANGES.map((d) => ({
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

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-0.5">
        <AccountStrip
          identities={identities}
          isLoading={connections.isLoading}
          canSee={isManager}
        />

        {/* Small multiples. Each keeps its own scale; only the x-axis is shared. */}
        {!nothingConnected && (
          <>
        <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
          <LineTrend
            labels={labels}
            series={[
              { key: 'reach', label: t('studio.stats.reach', 'Erişim'), points: days.map((d) => d.reach) },
            ]}
            title={t('studio.stats.reach', 'Erişim')}
            value={totals ? short(totals.reach) : '—'}
            isLoading={loading}
            emptyText={organicEmptyText ?? t('studio.stats.noOrganic', 'Organik veri yok')}
            height={118}
            ariaLabel={t('studio.stats.reachAria', 'Günlük organik erişim')}
            formatLabel={dayLabel}
            formatValue={num}
          />
          <LineTrend
            labels={labels}
            series={[
              {
                key: 'eng',
                label: t('studio.stats.engagements', 'Etkileşim'),
                points: days.map((d) => d.engagements),
              },
            ]}
            title={t('studio.stats.engagements', 'Etkileşim')}
            value={
              erate !== null
                ? `${erate.toFixed(1)}%`
                : totals
                  ? short(totals.engagements)
                  : '—'
            }
            caption={
              erate !== null
                ? t('studio.stats.erateCaption', 'etkileşim / gösterim')
                : undefined
            }
            isLoading={loading}
            emptyText={organicEmptyText ?? t('studio.stats.noOrganic', 'Organik veri yok')}
            height={118}
            ariaLabel={t('studio.stats.engAria', 'Günlük organik etkileşim')}
            formatLabel={dayLabel}
            formatValue={num}
          />
          <LineTrend
            labels={labels}
            series={followerSeries}
            title={t('studio.stats.followers', 'Takipçi')}
            value={followers !== null ? short(followers) : '—'}
            caption={
              // Silent when the read failed: "no network reported a follower
              // count" is the same false assertion the empty state above it has
              // just been corrected out of making, and a caption contradicting
              // its own chart is worse than either version alone.
              organicUnread
                ? undefined
                : followers === null
                ? t('studio.stats.noFollowers', 'Hiçbir ağ takipçi sayısı bildirmedi')
                : followersPartial
                  ? t(
                      'studio.stats.followersPartial',
                      '{{n}} hesabın {{k}} tanesi takipçi sayısı bildirdi — toplam yalnızca onları kapsıyor',
                      { n: accountRows.length, k: reported },
                    )
                  : undefined
            }
            isLoading={loading}
            emptyText={organicEmptyText ?? t('studio.stats.noFollowerData', 'Takipçi verisi yok')}
            height={118}
            ariaLabel={t('studio.stats.followersAria', 'Hesap başına günlük takipçi sayısı')}
            formatLabel={dayLabel}
            formatValue={num}
          />
          <LineTrend
            labels={labels}
            series={[
              {
                key: 'spend',
                label: t('studio.stats.spend', 'Reklam harcaması'),
                points: adDays.map((d) => d.spend),
              },
            ]}
            title={t('studio.stats.spend', 'Reklam harcaması')}
            value={ads.data ? money(ads.data.totals.spend) : '—'}
            caption={spendCaveat}
            isLoading={ads.isLoading}
            emptyText={
              adsUnread
                ? t('studio.stats.adsUnread', 'Reklam verileri okunamadı')
                : t('studio.stats.noAds', 'Reklam verisi yok')
            }
            height={118}
            ariaLabel={t('studio.stats.spendAria', 'Günlük reklam harcaması')}
            formatLabel={dayLabel}
            formatValue={money}
          />
        </div>

        <StackedBars
          labels={labels}
          categories={publishSeries}
          title={t('studio.stats.publishedTitle', 'Yayınlanan içerik')}
          value={totals ? num(totals.posts) : '—'}
          caption={t(
            'studio.stats.publishedCaption',
            'Kaç içerik çıktı — kaç kişiye ulaştığı değil.',
          )}
          isLoading={loading}
          emptyText={organicEmptyText ?? t('studio.stats.noPublished', 'Bu aralıkta yayınlanan içerik yok')}
          height={88}
          ariaLabel={t('studio.stats.publishedAria', 'Gün başına yayınlanan içerik sayısı')}
          formatLabel={dayLabel}
          formatValue={num}
        />
          </>
        )}

        {/* `!isManager ||` — the one line a rep must always get.
            `nothingConnected` folds in `identities.length === 0`, which for a
            rep is not a fact about the workspace: the connections query is
            `enabled: isManager`, so `data` is undefined and the length is zero
            by construction. Short-circuiting on it took the manager-only
            sentence away from exactly the reader it was written for — and with
            AccountStrip already null (`canSee`) and the charts skipped, a rep
            in a workspace with no ad account got a heading, a range control and
            nothing else. The honest floor for a rep is the sentence saying what
            they are not seeing; CoverageNote renders it first thing on
            `!canSee`, before it looks at coverage at all. */}
        {(!isManager || !nothingConnected) && (
          <CoverageNote
            coverage={data?.coverage}
            accounts={data?.byAccount}
            canSee={isManager}
          />
        )}
      </div>
    </div>
  );
}

/**
 * One chip per connected identity: the brand mark, the name, and — the only
 * reason this strip exists rather than a count — whether the connection is
 * actually working.
 *
 * A workspace whose Instagram token expired last Tuesday sees zeros on every
 * chart above and no explanation anywhere. The health badge is that explanation,
 * and it sits next to the charts precisely so the two are read together.
 */
function AccountStrip({
  identities,
  isLoading,
  canSee,
}: {
  identities: { identityKey: string; displayName: string; provider: string; health: string }[];
  isLoading?: boolean;
  canSee: boolean;
}) {
  const { t } = useTranslation('marketing');

  if (!canSee) return null;
  if (isLoading) {
    return (
      <div className="flex gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-7 w-28 rounded-full" />
        ))}
      </div>
    );
  }
  if (!identities.length) {
    return (
      <EmptyState
        icon={<Plug className="h-5 w-5" />}
        title={t('studio.stats.noAccounts', 'Henüz bağlı hesap yok')}
        description={t(
          'studio.stats.noAccountsDesc',
          'Bir sosyal hesap bağla; yayın da, istatistik de buradan akmaya başlasın.',
        )}
        action={
          <Button asChild size="sm">
            <Link to="/accounts">{t('studio.stats.connect', 'Hesap bağla')}</Link>
          </Button>
        }
      />
    );
  }

  return (
    <ul className="flex flex-wrap gap-1.5">
      {identities.map((c) => {
        const broken = c.health === 'REAUTH_REQUIRED' || c.health === 'DISABLED';
        return (
          <li key={c.identityKey}>
            <Link
              to="/accounts"
              className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-caption text-foreground transition-colors hover:bg-muted/40"
            >
              <ProviderLogo provider={c.provider as never} className="h-3.5 w-3.5" />
              <span className="max-w-[10rem] truncate">{c.displayName}</span>
              {broken && (
                <Badge tone="danger">
                  {c.health === 'REAUTH_REQUIRED'
                    ? t('studio.stats.reauth', 'Yeniden bağla')
                    : t('studio.stats.disabled', 'Kapalı')}
                </Badge>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What the numbers above do NOT cover.
 *
 * This is the line that keeps the panel honest. Organic insights need a
 * per-network permission the workspace may never have been granted, and when a
 * network cannot be read its posts contribute nothing — which looks exactly like
 * posting nothing. Naming the network is the difference between "we are doing
 * badly there" and "we cannot see there", and only one of those is a reason to
 * change what you publish.
 *
 * TWO KINDS OF BLIND SPOT, KEPT APART. `unsupportedNetworks` is permanent —
 * there is no API to call, however the grant is fixed — and reads as a fact
 * about the platform. A per-account `insightsError` is the opposite: we asked,
 * we were refused, and the refusal has a reason and often a fix (an app review
 * clears the scope; a rate limit clears itself). Folding them into one warning
 * would tell the owner nothing can be done about a problem that can, so they get
 * separate sentences and the failing accounts are named individually with the
 * provider's own words next to them.
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
  // possible version of the truth. Capped at three so one broken workspace does
  // not push the charts off the panel; the rest are summarised as a remainder.
  const failing = (accounts ?? []).filter((a) => Boolean(a.insightsError));
  const shown = failing.slice(0, 3);
  const stale = coverage.lastPulledAt
    ? new Date(coverage.lastPulledAt).toLocaleString(i18n.language, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div className="space-y-1">
      {unread.length > 0 && (
        <p role="status" className="flex items-start gap-1.5 text-micro text-warning">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t('studio.stats.unreadable', 'Okunamayan ağlar')}:{' '}
            {unread
              .map((n) => NETWORK_META[n as keyof typeof NETWORK_META]?.label ?? n)
              .join(', ')}{' '}
            —{' '}
            {t(
              'studio.stats.unreadableHint',
              'buraya yayın yapabiliyoruz ama istatistiklerini okuyamıyoruz, yukarıdaki sayılara dahil değiller',
            )}
          </span>
        </p>
      )}
      {shown.length > 0 && (
        <div role="status" className="flex items-start gap-1.5 text-micro text-warning">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div>
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
        </div>
      )}
      {coverage.accountsWithData < coverage.accounts && (
        <p role="status" className="text-micro text-muted-foreground">
          {t('studio.stats.partial', '{{n}} hesabın {{k}} tanesinden veri geldi', {
            n: coverage.accounts,
            k: coverage.accountsWithData,
          })}
        </p>
      )}
      <p className="text-micro text-muted-foreground">
        {stale
          ? t('studio.stats.lastPulled', 'Son güncelleme: {{when}}', { when: stale })
          : t('studio.stats.neverPulled', 'İstatistikler henüz bir kez bile çekilmedi')}
      </p>
    </div>
  );
}
