import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import TrendsPage from './TrendsPage';
import * as svc from '../../../features/marketing/api/trends.service';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string } | string) => (typeof o === 'string' ? o : (o?.defaultValue ?? k)) }),
}));
vi.mock('../../../features/marketing/api/trends.service', () => ({ listTrends: vi.fn(), saveTrend: vi.fn(), remixTrend: vi.fn() }));

// Save/remix are MANAGER-gated on the backend — the page hides those
// affordances for non-managers. Role is switchable per test.
const authState = { user: { role: 'MANAGER', id: 'u-1' } as { role: string; id: string } | null };
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => authState,
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><TrendsPage /></MemoryRouter></QueryClientProvider>);
}

describe('TrendsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { role: 'MANAGER', id: 'u-1' };
  });
  it('shows the empty state with no trends', async () => {
    (svc.listTrends as any).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No trends captured yet')).toBeInTheDocument();
  });
  it('lists trend templates with platform + risk badges', async () => {
    (svc.listTrends as any).mockResolvedValue([{ id: 't1', sourcePlatform: 'TIKTOK', sourceUrl: null, title: 'Price hook', hookPattern: null, pacingNote: null, captionPattern: null, riskScore: 80, status: 'ACTIVE', createdAt: '' }]);
    renderPage();
    expect((await screen.findAllByText('Price hook')).length).toBeGreaterThan(0);
    expect(screen.getByText('TikTok')).toBeInTheDocument();
  });
  it('a MANAGER sees Save-a-trend and the Remix panel', async () => {
    (svc.listTrends as any).mockResolvedValue([{ id: 't1', sourcePlatform: 'TIKTOK', sourceUrl: null, title: 'Price hook', hookPattern: null, pacingNote: null, captionPattern: null, riskScore: 10, status: 'ACTIVE', createdAt: '' }]);
    renderPage();
    // Await the DATA-dependent panel first — the header button renders before
    // the query resolves, so asserting it alone would pass too early.
    expect(await screen.findByText('Remix to your brand')).toBeInTheDocument();
    expect(screen.getAllByText('Save a trend').length).toBeGreaterThan(0);
  });
  it('a REP sees the read-only list — no Save button, no Remix panel (backend would 400 them)', async () => {
    authState.user = { role: 'REP', id: 'u-2' };
    (svc.listTrends as any).mockResolvedValue([{ id: 't1', sourcePlatform: 'TIKTOK', sourceUrl: null, title: 'Price hook', hookPattern: null, pacingNote: null, captionPattern: null, riskScore: 10, status: 'ACTIVE', createdAt: '' }]);
    renderPage();
    expect((await screen.findAllByText('Price hook')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Save a trend')).not.toBeInTheDocument();
    expect(screen.queryByText('Remix to your brand')).not.toBeInTheDocument();
  });
});
