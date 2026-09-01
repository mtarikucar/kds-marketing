import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';
import AccountStatsPanel from './AccountStatsPanel';
import * as insightsService from '../../../features/marketing/api/socialInsights.service';
import type { SocialInsightsResponse } from '../../../features/marketing/api/socialInsights.service';
import * as adsService from '../../../features/marketing/api/ads.service';
import type { AdMetricsResponse, AdAccount } from '../../../features/marketing/api/ads.service';
import * as connectionHooks from '../accounts/hooks';

vi.mock('../../../features/marketing/api/socialInsights.service', async (orig) => ({
  // The derived helpers (engagementRate, totalFollowers) are pure and are part
  // of what is under test here — only the network calls are mocked.
  ...(await orig<typeof insightsService>()),
  getSocialInsights: vi.fn(),
  pullSocialInsights: vi.fn(),
}));
vi.mock('../../../features/marketing/api/ads.service');
// The refresh button's outcome is a toast, so the toaster is the only place the
// 409-vs-failure distinction is observable.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../accounts/hooks', async (orig) => ({
  ...(await orig<typeof connectionHooks>()),
  useConnections: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // The inline default is what actually renders in this product, so the tests
    // assert on Turkish copy rather than on key names.
    t: (_k: string, d?: string | Record<string, unknown>, o?: Record<string, unknown>) => {
      const def = typeof d === 'string' ? d : '';
      const vars = (typeof d === 'string' ? o : (d as Record<string, unknown>)) ?? {};
      return def.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
    },
    i18n: { language: 'tr' },
  }),
}));

const mockRole = vi.fn(() => 'OWNER' as string | undefined);
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: mockRole() } }),
}));

const getSocialInsights = vi.mocked(insightsService.getSocialInsights);
const pullSocialInsights = vi.mocked(insightsService.pullSocialInsights);
const getAdMetrics = vi.mocked(adsService.getAdMetrics);
const listAdAccounts = vi.mocked(adsService.listAdAccounts);
const useConnections = vi.mocked(connectionHooks.useConnections);

const emptyBucket = {
  impressions: 0,
  reach: 0,
  engagements: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  clicks: 0,
  videoViews: 0,
  posts: 0,
};

const insights = (over: Partial<SocialInsightsResponse> = {}): SocialInsightsResponse => ({
  totals: { ...emptyBucket },
  byDay: [],
  byNetwork: {},
  byAccount: [],
  followersByDay: [],
  coverage: {
    accounts: 0,
    accountsWithData: 0,
    accountsWithErrors: 0,
    lastPulledAt: null,
    unsupportedNetworks: [],
  },
  ...over,
});

const accountRow = (over: Partial<SocialInsightsResponse['byAccount'][number]> = {}) => ({
  socialAccountId: 'a1',
  network: 'INSTAGRAM',
  displayName: '@jeeta',
  followers: 0,
  impressions: 0,
  reach: 0,
  engagements: 0,
  posts: 0,
  insightsError: null,
  ...over,
});

const adMetrics = (over: Partial<AdMetricsResponse> = {}): AdMetricsResponse => ({
  totals: { spend: 0, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 },
  byProvider: {},
  byDay: [],
  ...over,
});

const account = (over: Partial<AdAccount> = {}): AdAccount => ({
  id: 'ad-1',
  provider: 'META',
  externalAdId: 'act_1',
  displayName: 'Meta',
  status: 'ACTIVE',
  currency: 'TRY',
  lastPulledAt: null,
  lastError: null,
  createdAt: '2026-08-01T00:00:00Z',
  ...over,
});

function connections(list: { identityKey: string; displayName: string; health: string }[] = []) {
  return {
    data: {
      secretBoxConfigured: true,
      features: { conversationAi: true },
      networkStatus: {},
      providers: [
        {
          provider: 'META',
          displayName: 'Meta',
          connectMethod: 'OAUTH',
          configured: true,
          connections: list.map((c) => ({
            identityKey: c.identityKey,
            externalId: c.identityKey,
            displayName: c.displayName,
            connectedVia: 'OAUTH',
            capabilities: ['PUBLISH'],
            health: c.health,
            sources: [],
          })),
        },
      ],
    },
    isLoading: false,
  } as unknown as ReturnType<typeof connectionHooks.useConnections>;
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: ReactNode) =>
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
      </MemoryRouter>,
    );
  return wrap(<AccountStatsPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole.mockReturnValue('OWNER');
  getSocialInsights.mockResolvedValue(insights());
  pullSocialInsights.mockResolvedValue({ posts: 0, accounts: 0, errors: 0 });
  getAdMetrics.mockResolvedValue(adMetrics());
  listAdAccounts.mockResolvedValue([]);
  // One healthy connected account is the DEFAULT for this suite. The panel
  // deliberately draws nothing at all when a workspace has connected neither a
  // social nor an ad account — five charts of zeros read as a result rather than
  // as an absence — so every test about what the charts SAY needs something
  // connected. The zero-state has its own test below.
  useConnections.mockReturnValue(connections([{ identityKey: 'ig-1', displayName: '@jeeta', health: 'HEALTHY' }]));
});

describe('AccountStatsPanel', () => {
  it('asks for exactly N whole UTC day buckets, as instants', async () => {
    renderPanel();
    await screen.findByText('Bağlı hesaplar');

    const { from = '', to = '' } = getSocialInsights.mock.calls[0][0]!;
    // Never a bare YYYY-MM-DD: the backend parses with new Date(), so a bare
    // date is read as UTC midnight and an inclusive `lte` would then stop at the
    // START of the last day and drop it.
    expect(from).toMatch(/T00:00:00\.000Z$/);
    expect(to).toMatch(/T23:59:59\.999Z$/);
    const spanDays =
      (new Date(to).getTime() - new Date(from).getTime() + 1) / (24 * 3600_000);
    expect(spanDays).toBe(30);
  });

  it('plots the organic series and publishes the same numbers as a table', async () => {
    getSocialInsights.mockResolvedValue(
      insights({
        totals: { ...emptyBucket, reach: 1200, engagements: 60, impressions: 3000, posts: 4 },
        byDay: [{ date: '2026-08-30', reach: 700, impressions: 1500, engagements: 40, clicks: 5, videoViews: 0, posts: 2 }],
      }),
    );
    renderPanel();

    // The engagement headline is a RATE, and it is only a rate because there are
    // impressions to divide by.
    expect(await screen.findByText('2.0%')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Günlük organik erişim' });
    expect(within(table).getByRole('row', { name: /30 Ağu/ })).toHaveTextContent('700');
  });

  it('zero-fills the gaps, so a sparse month is not drawn as a busy one', async () => {
    getSocialInsights.mockResolvedValue(
      insights({
        totals: { ...emptyBucket, reach: 100, impressions: 100 },
        byDay: [{ date: '2026-08-30', reach: 100, impressions: 100, engagements: 0, clicks: 0, videoViews: 0, posts: 0 }],
      }),
    );
    renderPanel();

    const table = await screen.findByRole('table', { name: 'Günlük organik erişim' });
    // 30 requested days, one day of data — the other 29 must exist as zeros
    // rather than collapsing into a one-point line spread across the axis.
    expect(within(table).getAllByRole('row')).toHaveLength(31); // header + 30 days
  });

  it('names the networks it cannot read instead of averaging them into silence', async () => {
    getSocialInsights.mockResolvedValue(
      insights({
        coverage: {
          accounts: 3,
          accountsWithData: 1,
          accountsWithErrors: 0,
          lastPulledAt: '2026-08-31T06:00:00Z',
          unsupportedNetworks: ['TIKTOK'],
        },
      }),
    );
    renderPanel();

    expect(await screen.findByText(/Okunamayan ağlar/)).toHaveTextContent('TikTok');
    expect(screen.getByText(/3 hesabın 1 tanesinden veri geldi/)).toBeInTheDocument();
  });

  it('names the accounts that failed AND why, instead of a silent gap in the charts', async () => {
    // The backend has recorded a reason on every failed pull since the sweep
    // was written, and nothing ever read it: summary() did not select the
    // column and coverage returned only counts. So the panel built to say "we
    // could not read this" had a warning triangle and no facts behind it — a
    // denied scope looked exactly like a quiet month.
    getSocialInsights.mockResolvedValue(
      insights({
        byAccount: [
          accountRow({
            socialAccountId: 'a1',
            // Deliberately NOT the name in the connection strip above: the
            // assertion below must land on the coverage note, not on a chip.
            displayName: '@jeeta_ig',
            insightsError: '(#10) Requires instagram_manage_insights permission',
          }),
          accountRow({ socialAccountId: 'a2', displayName: 'Jeeta Page', network: 'FACEBOOK' }),
        ],
        coverage: {
          accounts: 2,
          accountsWithData: 1,
          accountsWithErrors: 1,
          lastPulledAt: '2026-08-31T06:00:00Z',
          unsupportedNetworks: [],
        },
      }),
    );
    renderPanel();

    expect(await screen.findByText('Okunamayan hesaplar:')).toBeInTheDocument();
    // Named, not counted: "1 account failed" is the least actionable version of
    // the truth. And the provider's own words, verbatim — that string is the
    // only thing that says which scope to go and ask for.
    const failure = screen.getByText('@jeeta_ig').closest('li')!;
    expect(failure).toHaveTextContent('instagram_manage_insights');
    // The healthy account is not listed as broken.
    expect(screen.queryByText('Jeeta Page')).not.toBeInTheDocument();
  });

  it('says nothing about failures when every account read cleanly', async () => {
    getSocialInsights.mockResolvedValue(
      insights({ byAccount: [accountRow({ insightsError: null })] }),
    );
    renderPanel();

    await screen.findByText('Bağlı hesaplar');
    expect(screen.queryByText('Okunamayan hesaplar:')).not.toBeInTheDocument();
  });

  it('says the numbers were never pulled rather than implying they are current', async () => {
    renderPanel();
    expect(
      await screen.findByText('İstatistikler henüz bir kez bile çekilmedi'),
    ).toBeInTheDocument();
  });

  it('drops the currency symbol when the ad accounts disagree about currency', async () => {
    listAdAccounts.mockResolvedValue([account(), account({ id: 'ad-2', provider: 'TIKTOK', currency: 'USD' })]);
    getAdMetrics.mockResolvedValue(
      adMetrics({ totals: { spend: 1000, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 } }),
    );
    renderPanel();

    // Summing lira and dollars into one figure is the best summary available,
    // but stamping it with either symbol claims a conversion nobody performed.
    expect(
      await screen.findByText(/farklı para birimlerinde — toplam dönüştürülmedi/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/₺1.000|\$1,000/)).not.toBeInTheDocument();
  });

  /**
   * A failed read is not an empty account.
   *
   * Both queries zero-fill their window up front, so a failure hands every
   * chart a flat run of zeros — which each chart correctly refuses to plot and
   * then labels "Organik veri yok" / "Reklam verisi yok". Those are flat
   * assertions about the business, made on the strength of a request that never
   * came back, and both queries are `meta: { silent: true }`, so nothing else
   * on the screen mentioned the failure either. The panel whose whole thesis is
   * refusing to state what it does not know was, in its commonest failure mode,
   * stating exactly that four times over.
   */
  it('says the statistics could not be read, rather than that there are none', async () => {
    getSocialInsights.mockRejectedValue(new Error('500'));
    renderPanel();

    // Three organic charts, one sentence — reach, engagement and followers all
    // depend on the read that failed.
    expect((await screen.findAllByText('Hesap istatistikleri okunamadı')).length).toBeGreaterThan(1);
    expect(screen.queryByText('Organik veri yok')).not.toBeInTheDocument();
    expect(screen.queryByText('Takipçi verisi yok')).not.toBeInTheDocument();
    // The ad half read fine and keeps its own, different, honest empty state:
    // the two failures are separate and are never merged into one apology.
    expect(screen.getByText('Reklam verisi yok')).toBeInTheDocument();
    // …and no caption underneath contradicting the chart it belongs to.
    expect(screen.queryByText(/Hiçbir ağ takipçi sayısı bildirmedi/)).not.toBeInTheDocument();
  });

  it('says the same for the ad half, on its own', async () => {
    getAdMetrics.mockRejectedValue(new Error('500'));
    renderPanel();

    expect(await screen.findByText('Reklam verileri okunamadı')).toBeInTheDocument();
    expect(screen.queryByText('Reklam verisi yok')).not.toBeInTheDocument();
    // …and the organic half, which succeeded, still says what IT knows.
    expect(screen.getAllByText('Organik veri yok').length).toBeGreaterThan(0);
  });

  /**
   * The other way the currency can be missing, and the one nothing covered.
   *
   * `money()` drops to an unadorned grouped number whenever it has no code, and
   * the only sentence that ever explained that was gated on there being MORE
   * THAN ONE ad account. So a workspace whose `listAdAccounts` read failed — or
   * whose single account carries no currency string at all — got its entire ad
   * spend rendered as a naked "1.000" under "Reklam harcaması", with nothing on
   * the panel saying which money that is. Unknown is not the same admission as
   * mixed, and the wrong one of the two was silence.
   */
  it('says the currency is unknown when the ad-account read failed', async () => {
    listAdAccounts.mockRejectedValue(new Error('403'));
    getAdMetrics.mockResolvedValue(
      adMetrics({ totals: { spend: 1000, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 } }),
    );
    renderPanel();

    expect(await screen.findByText(/Para birimi okunamadı/)).toBeInTheDocument();
    // Not the mixed-currency sentence: nobody disagreed, we simply could not ask.
    expect(screen.queryByText(/farklı para birimlerinde/)).not.toBeInTheDocument();
  });

  it('says the same when the one connected ad account carries no currency', async () => {
    listAdAccounts.mockResolvedValue([account({ currency: '' })]);
    getAdMetrics.mockResolvedValue(
      adMetrics({ totals: { spend: 1000, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 } }),
    );
    renderPanel();

    expect(await screen.findByText(/Para birimi okunamadı/)).toBeInTheDocument();
  });

  it('does not caption a spend of zero, which claims no money at all', async () => {
    // The caveat qualifies a FIGURE. A permanent footnote under an empty chart
    // is noise, and noise is how people learn to stop reading footnotes.
    listAdAccounts.mockRejectedValue(new Error('403'));
    renderPanel();

    await screen.findByText('Bağlı hesaplar');
    await waitFor(() => expect(listAdAccounts).toHaveBeenCalled());
    expect(screen.queryByText(/Para birimi okunamadı/)).not.toBeInTheDocument();
  });

  /**
   * The follower headline is a SUM over the accounts that answered. When only
   * some of them did, that sum is the audience of a subset wearing the label of
   * the whole workspace — and the coverage note below the charts does not cover
   * it, because it speaks about insights (impressions, reach, engagement), and
   * an account can report all three while its follower field stays at the
   * backend's "never read" zero.
   */
  it('says how many accounts the follower total actually covers', async () => {
    getSocialInsights.mockResolvedValue(
      insights({
        byAccount: [
          accountRow({ socialAccountId: 'a1', followers: 1200 }),
          accountRow({ socialAccountId: 'a2', displayName: '@other', followers: 0 }),
          accountRow({ socialAccountId: 'a3', displayName: '@third', followers: 0 }),
        ],
      }),
    );
    renderPanel();

    expect(
      await screen.findByText(/3 hesabın 1 tanesi takipçi sayısı bildirdi/),
    ).toBeInTheDocument();
  });

  it('says nothing extra when every account reported one', async () => {
    getSocialInsights.mockResolvedValue(
      insights({
        byAccount: [
          accountRow({ socialAccountId: 'a1', followers: 1200 }),
          accountRow({ socialAccountId: 'a2', displayName: '@other', followers: 800 }),
        ],
      }),
    );
    renderPanel();

    await screen.findByText('Bağlı hesaplar');
    await waitFor(() => expect(getSocialInsights).toHaveBeenCalled());
    expect(screen.queryByText(/takipçi sayısı bildirdi/)).not.toBeInTheDocument();
  });

  it('shows the currency when every ad account agrees', async () => {
    listAdAccounts.mockResolvedValue([account(), account({ id: 'ad-2', currency: 'TRY' })]);
    getAdMetrics.mockResolvedValue(
      adMetrics({ totals: { spend: 1000, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 } }),
    );
    renderPanel();

    // The spend headline carries the symbol, because every scoped account
    // agrees on the currency — and the mixed-currency warning is absent.
    expect((await screen.findAllByText(/₺/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/farklı para birimlerinde/)).not.toBeInTheDocument();
  });

  it('flags a connection that needs reconnecting, next to the charts it explains', async () => {
    useConnections.mockReturnValue(
      connections([{ identityKey: 'ig-1', displayName: '@jeeta', health: 'REAUTH_REQUIRED' }]),
    );
    renderPanel();

    expect(await screen.findByText('@jeeta')).toBeInTheDocument();
    expect(screen.getByText('Yeniden bağla')).toBeInTheDocument();
  });

  it('draws nothing but a connect CTA when nothing is connected at all', async () => {
    // Not merely "empty": with no social account and no ad account the five
    // charts are five boxes of zeros, and a wall of zeros reads as a RESULT —
    // as though the accounts were connected and doing nothing.
    useConnections.mockReturnValue(connections());
    renderPanel();

    expect(await screen.findByText('Henüz bağlı hesap yok')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Hesap bağla' })).toHaveAttribute('href', '/accounts');
    // waitFor, because the panel deliberately keeps drawing until BOTH the
    // connections and the ad-account reads have settled — flashing a "connect
    // an account" CTA at a workspace that has one is worse than a moment of
    // charts.
    await waitFor(() => expect(screen.queryAllByRole('table')).toHaveLength(0));
    expect(screen.queryByRole('img', { name: 'Günlük organik erişim' })).not.toBeInTheDocument();
  });

  it('still draws the charts for an ad-only workspace', async () => {
    // An ad account with no social account has a real spend series; hiding the
    // charts there would throw away the one thing that IS measurable.
    useConnections.mockReturnValue(connections());
    listAdAccounts.mockResolvedValue([account()]);
    getAdMetrics.mockResolvedValue(
      adMetrics({
        totals: { spend: 120, impressions: 900, clicks: 12, leads: 2, revenue: 0, roas: 0 },
        byDay: [{ date: '2026-08-30', spend: 120, impressions: 900, clicks: 12, leads: 2, revenue: 0, roas: 0 }],
      }),
    );
    renderPanel();

    expect(await screen.findByRole('img', { name: 'Günlük reklam harcaması' })).toBeInTheDocument();
  });

  it('re-requests the window when the range changes', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Bağlı hesaplar');

    const first = getSocialInsights.mock.calls[0][0]!;
    await user.click(screen.getByRole('button', { name: '7 gün' }));

    const last = getSocialInsights.mock.calls.at(-1)![0]!;
    expect(last.from).not.toBe(first.from);
    // Both charts must move together — filters scope everything below them, or
    // two charts are being read against different windows.
    expect(getAdMetrics.mock.calls.at(-1)![0]!.from).toBe((last.from ?? '').slice(0, 10));
  });

  it('does not fire the manager-only queries for a rep, and says why', async () => {
    mockRole.mockReturnValue('REP');
    renderPanel();

    expect(await screen.findByText(/yalnızca yöneticiler görebilir/)).toBeInTheDocument();
    expect(getSocialInsights).not.toHaveBeenCalled();
    // The connection strip is manager-only too (`GET marketing/connections` is
    // `@MarketingRoles('MANAGER')`), and this was the one that got missed: an
    // unconditional call 403s and main.tsx toasts it, so the rep's front door
    // opened on a "Forbidden" instead of on the quiet sentence above.
    expect(useConnections).toHaveBeenCalledWith({ enabled: false });
    // The ad charts need only reports.read, so a rep still gets that half.
    expect(getAdMetrics).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'İstatistikleri yenile' })).not.toBeInTheDocument();
  });

  it('does not leave a rep with nothing but a heading and a range control', async () => {
    // The whole top-left third, hollow. `nothingConnected` folds in
    // `identities.length === 0`, and for a rep that length is zero BY
    // CONSTRUCTION: useConnections is `enabled: false`, so RQ never fetches,
    // `data` is undefined and `isLoading` is false. With no ad account either,
    // the charts short-circuited AND the coverage note short-circuited, while
    // AccountStrip had already returned null on `canSee` — a heading, a
    // segmented control, and nothing under them. Reachable today via a
    // `/budget` bookmark, and every rep's first impression of the surface once
    // /studio is in the rail.
    mockRole.mockReturnValue('REP');
    // The real disabled-query shape, not the suite's default stub: the default
    // hands back data the component could never have received.
    useConnections.mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof connectionHooks.useConnections>);
    listAdAccounts.mockResolvedValue([]);
    renderPanel();

    // Wait for the SETTLED state, the way the zero-state test above does: while
    // the ad-account read is still in flight `nothingConnected` is false and the
    // charts are on screen, so asserting straight away passes on the bug.
    await waitFor(() => expect(screen.queryByText('Erişim')).not.toBeInTheDocument());

    // What is left must not be a heading and a range control.
    expect(screen.getByText(/yalnızca yöneticiler görebilir/)).toBeInTheDocument();
    // And it is the connect-an-account CTA's slot that stayed empty — that one
    // is manager-only for a reason (a rep cannot connect anything), so the
    // sentence is the whole of the honest floor here, not a fallback for it.
    expect(screen.queryByText('Henüz bağlı hesap yok')).not.toBeInTheDocument();
  });

  it('does ask for the connection strip when the reader is allowed to see it', async () => {
    renderPanel();
    await screen.findByText('Bağlı hesaplar');
    expect(useConnections).toHaveBeenCalledWith({ enabled: true });
  });

  it('pulls fresh insights on demand', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'İstatistikleri yenile' }));
    expect(pullSocialInsights).toHaveBeenCalledTimes(1);
  });

  it('treats "already refreshing" as news, not as a failure', async () => {
    // The backend takes a per-workspace lock on the pull, so a second click —
    // or one that lands while the hourly sweep is on this workspace — comes
    // back 409. An error toast there reports a problem where the only thing
    // that happened is that the numbers are already on their way.
    const user = userEvent.setup();
    pullSocialInsights.mockRejectedValue({ response: { status: 409 } });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'İstatistikleri yenile' }));

    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(vi.mocked(toast.info).mock.calls[0][0]).toMatch(/zaten güncelleniyor/);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
