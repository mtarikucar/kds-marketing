import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';
import AccountStatsPanel, { type StudioRange } from './AccountStatsPanel';
import { trailingUtcDays } from './todayBounds';
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

const organicDay = (date: string, over: Partial<SocialInsightsResponse['byDay'][number]> = {}) => ({
  date,
  reach: 0,
  impressions: 0,
  engagements: 0,
  clicks: 0,
  videoViews: 0,
  posts: 0,
  ...over,
});

const adMetrics = (over: Partial<AdMetricsResponse> = {}): AdMetricsResponse => ({
  totals: { spend: 0, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 },
  byProvider: {},
  byDay: [],
  ...over,
});

const adDay = (date: string, over: Partial<AdMetricsResponse['byDay'][number]> = {}) => ({
  date,
  spend: 0,
  impressions: 0,
  clicks: 0,
  leads: 0,
  revenue: 0,
  roas: 0,
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

/** The panel no longer owns the window — the screen does. */
const onRangeChange = vi.fn();
function renderPanel(range: StudioRange = 30) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { from, to } = trailingUtcDays(range);
  const wrap = (ui: ReactNode) =>
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
      </MemoryRouter>,
    );
  return wrap(
    <AccountStatsPanel range={range} onRangeChange={onRangeChange} from={from} to={to} />,
  );
}

/** The last N UTC day keys, so a fixture can put data on days the window covers. */
const recentDays = (n: number) => {
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  return Array.from({ length: n }, (_, i) =>
    new Date(today.getTime() - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
};

/** Which slots are on screen, in the order they are drawn. */
const slotKeys = () =>
  screen
    .getAllByTestId(/^stat-slot-/)
    .map((el) => el.getAttribute('data-testid')!.replace('stat-slot-', ''));

beforeEach(() => {
  vi.clearAllMocks();
  mockRole.mockReturnValue('OWNER');
  getSocialInsights.mockResolvedValue(insights());
  pullSocialInsights.mockResolvedValue({ posts: 0, accounts: 0, errors: 0 });
  getAdMetrics.mockResolvedValue(adMetrics());
  listAdAccounts.mockResolvedValue([]);
  // One healthy connected account is the DEFAULT for this suite: the panel says
  // something different (and shorter) when the workspace has connected nothing
  // at all, and that state has its own test below.
  useConnections.mockReturnValue(connections([{ identityKey: 'ig-1', displayName: '@jeeta', health: 'HEALTHY' }]));
});

describe('AccountStatsPanel', () => {
  it('asks for exactly the window it was handed', async () => {
    renderPanel();
    await screen.findByText('Öne çıkan istatistikler');

    const { from = '', to = '' } = getSocialInsights.mock.calls[0][0]!;
    // Never a bare YYYY-MM-DD: the backend parses with new Date(), so a bare
    // date is read as UTC midnight and an inclusive `lte` would then stop at the
    // START of the last day and drop it.
    expect(from).toMatch(/T00:00:00\.000Z$/);
    expect(to).toMatch(/T23:59:59\.999Z$/);
    const spanDays = (new Date(to).getTime() - new Date(from).getTime() + 1) / (24 * 3600_000);
    expect(spanDays).toBe(30);
  });

  /**
   * The whole thesis of the band, in one assertion.
   *
   * Six metrics are known; three slots exist; only the metrics that HAVE data
   * may take one. Reach and engagement have nothing here (the scopes are not
   * granted), so the slots go to the next three that do — and none of them is a
   * tile reading "no organic data", which is the defect this rework answers.
   */
  it('gives the three slots to the highest-ranked metrics that actually have data', async () => {
    const [d1, d2] = recentDays(2);
    getSocialInsights.mockResolvedValue(
      insights({
        totals: { ...emptyBucket, posts: 4 },
        byDay: [organicDay(d1, { posts: 2 }), organicDay(d2, { posts: 2 })],
        byAccount: [accountRow({ followers: 1200 })],
        followersByDay: [{ date: d2, byAccount: { a1: 1200 } }],
      }),
    );
    listAdAccounts.mockResolvedValue([account()]);
    getAdMetrics.mockResolvedValue(
      adMetrics({
        totals: { spend: 900, impressions: 0, clicks: 0, leads: 6, revenue: 0, roas: 0 },
        byDay: [adDay(d1, { spend: 400, leads: 2 }), adDay(d2, { spend: 500, leads: 4 })],
      }),
    );
    renderPanel();

    await waitFor(() => expect(slotKeys()).toHaveLength(3));
    // Ranked, not sorted by size: ad spend is nine hundred and published is
    // four, and published still wins because the ranking is about what the
    // number is FOR, not how big it is.
    expect(slotKeys()).toEqual(['published', 'followers', 'leads']);
    expect(screen.queryByText('Erişim')).not.toBeInTheDocument();
    expect(screen.queryByText('Reklam harcaması')).not.toBeInTheDocument();
  });

  it('names the higher-ranked metrics it could not show, with the reason', async () => {
    const [d1, d2] = recentDays(2);
    getSocialInsights.mockResolvedValue(
      insights({
        totals: { ...emptyBucket, posts: 4 },
        byDay: [organicDay(d1, { posts: 2 }), organicDay(d2, { posts: 2 })],
      }),
    );
    renderPanel();

    // Reach and engagement outrank the one slot that filled, so their absence
    // is information: it is the difference between "we did badly there" and "we
    // cannot see there".
    const missing = await screen.findByTestId('stats-missing');
    // Grouped by reason so that one line can name every one of them rather
    // than capping the list and dropping whichever sorted last.
    expect(missing).toHaveTextContent('Erişim, Etkileşim (organik veri yok)');
  });

  it('shows fewer than three rather than padding with empties', async () => {
    const [d1, d2] = recentDays(2);
    getSocialInsights.mockResolvedValue(
      insights({
        totals: { ...emptyBucket, posts: 3 },
        byDay: [organicDay(d1, { posts: 1 }), organicDay(d2, { posts: 2 })],
      }),
    );
    renderPanel();

    await waitFor(() => expect(slotKeys()).toEqual(['published']));
    expect(screen.getByTestId('stats-missing')).toBeInTheDocument();
  });

  /**
   * A failed read is not an empty metric, and it must not be reported as one.
   *
   * Both queries zero-fill their window before they resolve, so a failure hands
   * every series a flat run of zeros. Judging "has data" off those zeros would
   * disqualify reach for looking like a measured nothing, and then say so in
   * the words reserved for a real zero.
   */
  it('says the organic numbers could not be READ, not that there are none', async () => {
    getSocialInsights.mockRejectedValue(new Error('500'));
    listAdAccounts.mockResolvedValue([account()]);
    getAdMetrics.mockResolvedValue(
      adMetrics({
        totals: { spend: 100, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 },
        byDay: [adDay(recentDays(1)[0], { spend: 100 })],
      }),
    );
    renderPanel();

    // waitFor, not a bare assertion: while the read is still in flight nothing
    // is an error yet, and asserting on that first paint passes on the bug.
    await waitFor(() =>
      expect(screen.getByTestId('stats-missing')).toHaveTextContent('Hesap istatistikleri okunamadı'),
    );
    expect(screen.getByTestId('stats-missing')).not.toHaveTextContent('organik veri yok');
    // The ad half read fine and keeps its slot — the two failures are separate
    // and are never merged into one apology.
    await waitFor(() => expect(slotKeys()).toEqual(['spend']));
  });

  it('says the same for the ad half, on its own', async () => {
    const [d1, d2] = recentDays(2);
    getSocialInsights.mockResolvedValue(
      insights({
        totals: { ...emptyBucket, reach: 500, impressions: 500 },
        byDay: [organicDay(d1, { reach: 200, impressions: 200 }), organicDay(d2, { reach: 300, impressions: 300 })],
      }),
    );
    listAdAccounts.mockResolvedValue([account()]);
    getAdMetrics.mockRejectedValue(new Error('500'));
    renderPanel();

    await waitFor(() => expect(slotKeys()).toEqual(['reach']));
    await waitFor(() =>
      expect(screen.getByTestId('stats-missing')).toHaveTextContent('Reklam verileri okunamadı'),
    );
  });

  /**
   * Movement is half against half, with equal-length halves.
   *
   * Thirty days: the last fifteen (120) against the first fifteen (60) is
   * +100%. If the split were "everything after the midpoint" against
   * "everything before it", an odd window would compare fifteen days with
   * sixteen and quietly put a day of volume into the answer.
   */
  it('reports a flow metric moving against the first half of the same window', async () => {
    // The whole 30-day window, because that is what the halves are cut from:
    // fifteen days at 4 against fifteen at 8 is +100%.
    const days = recentDays(30);
    getSocialInsights.mockResolvedValue(
      insights({
        totals: { ...emptyBucket, posts: 180 },
        byDay: days.map((d, i) => organicDay(d, { posts: i < 15 ? 4 : 8 })),
      }),
    );
    renderPanel();

    const move = await screen.findByTestId('stat-move-published');
    expect(move).toHaveAttribute('data-direction', 'up');
    expect(move).toHaveTextContent('%100');
  });

  /**
   * The halves must be the SAME LENGTH, which only an odd window can prove.
   *
   * Seven days split as "the last three against the first three, middle day
   * dropped". The obvious alternative — everything from the midpoint on,
   * against everything before it — compares four days with three, and the extra
   * day carries real volume: here it is a 99-post spike that would turn a
   * genuine +100% into +3400%.
   */
  it('drops the middle day of an odd window rather than comparing 4 days with 3', async () => {
    const days = recentDays(7);
    const posts = [1, 1, 1, 99, 2, 2, 2];
    getSocialInsights.mockResolvedValue(
      insights({
        totals: { ...emptyBucket, posts: 108 },
        byDay: days.map((d, i) => organicDay(d, { posts: posts[i] })),
      }),
    );
    renderPanel(7);

    const move = await screen.findByTestId('stat-move-published');
    expect(move).toHaveTextContent('%100');
  });

  it('reports a follower level against where it started, not as a sum', async () => {
    const days = recentDays(4);
    getSocialInsights.mockResolvedValue(
      insights({
        byAccount: [accountRow({ followers: 1100 })],
        followersByDay: [
          { date: days[0], byAccount: { a1: 1000 } },
          { date: days[3], byAccount: { a1: 1100 } },
        ],
      }),
    );
    renderPanel();

    const move = await screen.findByTestId('stat-move-followers');
    expect(move).toHaveAttribute('data-direction', 'up');
    // 1000 → 1100 is +10%, never 2100.
    expect(move).toHaveTextContent('%10');
  });

  it('shows the absolute change rather than a percentage of nothing', async () => {
    const days = recentDays(4);
    getSocialInsights.mockResolvedValue(
      insights({
        totals: { ...emptyBucket, posts: 6 },
        // Nothing in the first half; six in the second. Growth from zero is not
        // a percentage — every such move would print "+∞%".
        byDay: [organicDay(days[2], { posts: 3 }), organicDay(days[3], { posts: 3 })],
      }),
    );
    renderPanel();

    const move = await screen.findByTestId('stat-move-published');
    expect(move).toHaveAttribute('data-direction', 'up');
    expect(move).not.toHaveTextContent('%');
    expect(move).toHaveTextContent('6');
  });

  it('publishes the same numbers as an accessible table', async () => {
    const [d1, d2] = recentDays(2);
    getSocialInsights.mockResolvedValue(
      insights({
        totals: { ...emptyBucket, reach: 1200, engagements: 60, impressions: 3000 },
        byDay: [
          organicDay(d1, { reach: 700, impressions: 1500, engagements: 40 }),
          organicDay(d2, { reach: 500, impressions: 1500, engagements: 20 }),
        ],
      }),
    );
    renderPanel();

    // The engagement headline is a RATE, and it is only a rate because there are
    // impressions to divide by.
    expect(await screen.findByText('2.0%')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Günlük organik erişim' });
    expect(within(table).getAllByRole('row')).toHaveLength(31); // header + 30 days
  });

  /**
   * The coverage story survives the move out of the middle of the screen.
   *
   * Its headline is permanently visible — the existence of a blind spot is not
   * something you should have to click for — and every fact that used to be a
   * paragraph is one click behind it, including the provider's verbatim error.
   */
  it('keeps the blind spots on screen and their detail one click away', async () => {
    const user = userEvent.setup();
    getSocialInsights.mockResolvedValue(
      insights({
        byAccount: [
          accountRow({
            socialAccountId: 'a1',
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
          unsupportedNetworks: ['TIKTOK'],
        },
      }),
    );
    renderPanel();

    // Two blind spots — one unreadable network, one refused account — and the
    // trigger says so without being asked.
    expect(await screen.findByText(/2 kaynak okunamıyor/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Kapsam/ }));

    expect(await screen.findByText(/Okunamayan ağlar/)).toHaveTextContent('TikTok');
    // Named, not counted, and quoted verbatim: that string is the only thing
    // that says which scope to go and ask for.
    const failure = screen.getByText('@jeeta_ig').closest('li')!;
    expect(failure).toHaveTextContent('instagram_manage_insights');
    expect(screen.getByText(/2 hesabın 1 tanesinden veri geldi/)).toBeInTheDocument();
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
      adMetrics({
        totals: { spend: 1000, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 },
        byDay: [adDay(recentDays(1)[0], { spend: 1000 })],
      }),
    );
    renderPanel();

    // Summing lira and dollars into one figure is the best summary available,
    // but stamping it with either symbol claims a conversion nobody performed.
    expect(
      await screen.findByText(/farklı para birimlerinde — toplam dönüştürülmedi/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/₺1.000|\$1,000/)).not.toBeInTheDocument();
  });

  it('says the currency is unknown when the ad-account read failed', async () => {
    listAdAccounts.mockRejectedValue(new Error('403'));
    getAdMetrics.mockResolvedValue(
      adMetrics({
        totals: { spend: 1000, impressions: 0, clicks: 0, leads: 0, revenue: 0, roas: 0 },
        byDay: [adDay(recentDays(1)[0], { spend: 1000 })],
      }),
    );
    renderPanel();

    expect(await screen.findByText(/Para birimi okunamadı/)).toBeInTheDocument();
    // Not the mixed-currency sentence: nobody disagreed, we simply could not ask.
    expect(screen.queryByText(/farklı para birimlerinde/)).not.toBeInTheDocument();
  });

  it('does not caption a spend of zero, which claims no money at all', async () => {
    listAdAccounts.mockRejectedValue(new Error('403'));
    renderPanel();

    await screen.findByText('Öne çıkan istatistikler');
    await waitFor(() => expect(listAdAccounts).toHaveBeenCalled());
    expect(screen.queryByText(/Para birimi okunamadı/)).not.toBeInTheDocument();
  });

  it('says how many accounts the follower total actually covers', async () => {
    const days = recentDays(2);
    getSocialInsights.mockResolvedValue(
      insights({
        byAccount: [
          accountRow({ socialAccountId: 'a1', followers: 1200 }),
          accountRow({ socialAccountId: 'a2', displayName: '@other', followers: 0 }),
          accountRow({ socialAccountId: 'a3', displayName: '@third', followers: 0 }),
        ],
        followersByDay: [{ date: days[1], byAccount: { a1: 1200 } }],
      }),
    );
    renderPanel();

    expect(await screen.findByText(/3 hesabın 1 tanesi bildirdi/)).toBeInTheDocument();
  });

  it('says nothing at all rather than one sentence per absent metric', async () => {
    // Nothing has data anywhere, but everything is connected. Six correct "no
    // data" claims is a true statement made six times.
    listAdAccounts.mockResolvedValue([account()]);
    renderPanel();

    expect(
      await screen.findByText('Bu aralıkta gösterilebilecek bir istatistik yok.'),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^stat-slot-/)).toHaveLength(0);
  });

  it('says one sentence, and offers no second CTA, when nothing is connected at all', async () => {
    // The connect CTA lives in the accounts list at the top of the screen. Two
    // buttons offering the same route is how a screen stops being read.
    useConnections.mockReturnValue(connections());
    renderPanel();

    expect(await screen.findByText(/Bağlı hesap yok/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryAllByRole('link')).toHaveLength(0));
  });

  it('asks the screen for a new window when the range changes', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Öne çıkan istatistikler');

    await user.click(screen.getByRole('button', { name: '7 gün' }));

    // The panel does not own the window any more — the screen does, because the
    // account popovers in the top strip read the same one.
    expect(onRangeChange).toHaveBeenCalledWith(7);
  });

  it('scopes every slot to the window it was given', async () => {
    renderPanel(7);
    await screen.findByText('Öne çıkan istatistikler');

    const { from = '', to = '' } = getSocialInsights.mock.calls[0][0]!;
    const spanDays = (new Date(to).getTime() - new Date(from).getTime() + 1) / (24 * 3600_000);
    expect(spanDays).toBe(7);
    // Both reads move together, or two slots are being read against different
    // windows.
    expect(getAdMetrics.mock.calls[0][0]!.from).toBe(from.slice(0, 10));
  });

  it('does not fire the manager-only queries for a rep, and says why', async () => {
    mockRole.mockReturnValue('REP');
    renderPanel();

    expect(await screen.findByText(/yalnızca yöneticiler görebilir/)).toBeInTheDocument();
    expect(getSocialInsights).not.toHaveBeenCalled();
    expect(useConnections).toHaveBeenCalledWith({ enabled: false });
    // The ad charts need only reports.read, so a rep still gets that half.
    expect(getAdMetrics).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'İstatistikleri yenile' })).not.toBeInTheDocument();
  });

  /**
   * For a rep, `identities.length === 0` is not a fact about the workspace: the
   * connections query is `enabled: false`, so the length is zero by
   * construction. Two sentences the panel must therefore NOT say to a rep: that
   * nothing is connected, and that the organic metrics have no data.
   */
  it('never invents a workspace fact out of a query a rep was not allowed to make', async () => {
    mockRole.mockReturnValue('REP');
    useConnections.mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof connectionHooks.useConnections>);
    listAdAccounts.mockResolvedValue([]);
    renderPanel();

    await screen.findByText(/yalnızca yöneticiler görebilir/);
    await waitFor(() => expect(listAdAccounts).toHaveBeenCalled());
    expect(screen.queryByText(/Bağlı hesap yok/)).not.toBeInTheDocument();
    // The ad half is a rep's to see, so naming it as missing is honest. The
    // organic half is not: it was never asked for, and "organik veri yok" would
    // report a blind spot that is really a permission.
    expect(screen.getByTestId('stats-missing')).not.toHaveTextContent('organik veri yok');
    expect(screen.getByTestId('stats-missing')).toHaveTextContent('reklam verisi yok');
  });

  it('does ask for the connection strip when the reader is allowed to see it', async () => {
    renderPanel();
    await screen.findByText('Öne çıkan istatistikler');
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
