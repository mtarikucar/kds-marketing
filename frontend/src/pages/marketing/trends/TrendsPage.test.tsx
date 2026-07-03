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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><TrendsPage /></MemoryRouter></QueryClientProvider>);
}

describe('TrendsPage', () => {
  beforeEach(() => vi.clearAllMocks());
  it('shows the empty state with no trends', async () => {
    (svc.listTrends as any).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No trends captured yet')).toBeInTheDocument();
  });
  it('lists trend templates with platform + risk badges', async () => {
    (svc.listTrends as any).mockResolvedValue([{ id: 't1', sourcePlatform: 'TIKTOK', sourceUrl: null, title: 'Price hook', hookPattern: null, pacingNote: null, captionPattern: null, riskScore: 80, status: 'ACTIVE', createdAt: '' }]);
    renderPage();
    expect((await screen.findAllByText('Price hook')).length).toBeGreaterThan(0);
    expect(screen.getByText('TIKTOK')).toBeInTheDocument();
  });
});
