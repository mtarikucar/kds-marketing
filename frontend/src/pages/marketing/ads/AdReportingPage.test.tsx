import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AdReportingPage from './AdReportingPage';

const STATUS = { META: true, TIKTOK: true, secretBoxConfigured: true };
const ACCOUNTS = [
  {
    id: 'a1',
    provider: 'META',
    externalAdId: 'act_1',
    displayName: 'Acme — Meta Ads',
    status: 'ACTIVE',
    currency: 'USD',
    lastPulledAt: new Date().toISOString(),
    lastError: null,
    createdAt: new Date().toISOString(),
  },
];
const METRICS = {
  totals: { spend: 123.45, impressions: 1000, clicks: 40, leads: 5 },
  byProvider: { META: { spend: 123.45, impressions: 1000, clicks: 40, leads: 5 } },
  byDay: [{ date: '2026-06-20', spend: 123.45, impressions: 1000, clicks: 40, leads: 5 }],
};

const TIKTOK_PENDING = {
  advertisers: [{ externalAdId: 'adv_1', displayName: 'Acme TikTok', currency: 'USD' }],
  messaging: true,
};

vi.mock('../../../features/marketing/api/ads.service', () => ({
  getAdStatus: vi.fn(() => Promise.resolve(STATUS)),
  listAdAccounts: vi.fn(() => Promise.resolve(ACCOUNTS)),
  getAdMetrics: vi.fn(() => Promise.resolve(METRICS)),
  connectAdAccount: vi.fn(() => Promise.resolve(ACCOUNTS[0])),
  removeAdAccount: vi.fn(() => Promise.resolve({ message: 'ok' })),
  pullAdAccount: vi.fn(() => Promise.resolve({ written: 3 })),
  startTiktokAdsOAuth: vi.fn(() =>
    Promise.resolve({ authorizeUrl: 'https://tiktok.example/auth' }),
  ),
  getTiktokAdsPending: vi.fn(() => Promise.resolve(TIKTOK_PENDING)),
  confirmTiktokAdsPending: vi.fn(() =>
    Promise.resolve({ connectedAdAccounts: [], dmChannel: null }),
  ),
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { role: 'MANAGER' } }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AdReportingPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<AdReportingPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders the overview/accounts view toggle and a date-range control', () => {
    render(<AdReportingPage />, { wrapper });
    expect(screen.getByRole('group', { name: /ad reporting view/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /date range/i })).toBeInTheDocument();
  });

  it('shows aggregated spend once metrics resolve', async () => {
    render(<AdReportingPage />, { wrapper });
    // formatMoney renders the major-unit spend; it appears in the totals stat,
    // the by-provider row and the daily row — assert at least one shows.
    const cells = await screen.findAllByText(/123\.45/);
    expect(cells.length).toBeGreaterThan(0);
  });

  it('exposes the manager-only Connect account action', () => {
    render(<AdReportingPage />, { wrapper });
    expect(screen.getByRole('button', { name: /connect account/i })).toBeInTheDocument();
  });

  // ── TikTok OAuth connect tests ─────────────────────────────────────────────

  it('renders "Connect TikTok for Business" button enabled when status.TIKTOK is true', async () => {
    render(<AdReportingPage />, { wrapper });
    // Wait for the status query to resolve so the button becomes enabled
    await waitFor(async () => {
      const btn = await screen.findByRole('button', { name: /connect tiktok for business/i });
      expect(btn).not.toBeDisabled();
    });
  });

  it('renders "Connect TikTok for Business" button disabled when status.TIKTOK is false', async () => {
    const { getAdStatus } = await import('../../../features/marketing/api/ads.service');
    (getAdStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      META: true,
      TIKTOK: false,
      secretBoxConfigured: true,
    });
    render(<AdReportingPage />, { wrapper });
    const btn = await screen.findByRole('button', { name: /connect tiktok for business/i });
    expect(btn).toBeDisabled();
  });

  it('shows pending advertiser dialog when ?connect=<id> in URL and confirm calls confirm endpoint', async () => {
    const adsService = await import('../../../features/marketing/api/ads.service');
    const confirmMock = adsService.confirmTiktokAdsPending as ReturnType<typeof vi.fn>;

    const user = userEvent.setup();

    function wrapperWithConnect({ children }: { children: React.ReactNode }) {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return (
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/ads?connect=pending123&connect_provider=tiktok']}>
            {children}
          </MemoryRouter>
        </QueryClientProvider>
      );
    }

    render(<AdReportingPage />, { wrapper: wrapperWithConnect });

    // Dialog title should appear once the pending data loads
    expect(
      await screen.findByText(/choose tiktok advertiser accounts/i),
    ).toBeInTheDocument();

    // Advertiser should be listed
    expect(await screen.findByText('Acme TikTok')).toBeInTheDocument();

    // Click confirm
    const confirmBtn = screen.getByRole('button', { name: /connect selected/i });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith(
        'pending123',
        expect.objectContaining({ selected: ['adv_1'] }),
      );
    });
  });
});
