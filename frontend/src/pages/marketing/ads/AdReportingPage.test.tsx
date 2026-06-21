import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

vi.mock('../../../features/marketing/api/ads.service', () => ({
  getAdStatus: vi.fn(() => Promise.resolve(STATUS)),
  listAdAccounts: vi.fn(() => Promise.resolve(ACCOUNTS)),
  getAdMetrics: vi.fn(() => Promise.resolve(METRICS)),
  connectAdAccount: vi.fn(() => Promise.resolve(ACCOUNTS[0])),
  removeAdAccount: vi.fn(() => Promise.resolve({ message: 'ok' })),
  pullAdAccount: vi.fn(() => Promise.resolve({ written: 3 })),
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
});
