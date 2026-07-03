import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ContentCalendarPage from './ContentCalendarPage';
import * as svc from '../../../features/marketing/api/contentCalendar.service';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string } | string) => (typeof o === 'string' ? o : (o?.defaultValue ?? k)) }) }));
vi.mock('../../../features/marketing/api/contentCalendar.service', () => ({ listContentCalendar: vi.fn() }));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ContentCalendarPage /></MemoryRouter></QueryClientProvider>);
}

describe('ContentCalendarPage', () => {
  beforeEach(() => vi.clearAllMocks());
  it('shows the empty state', async () => {
    (svc.listContentCalendar as any).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument();
  });
  it('groups items by day with type + status', async () => {
    (svc.listContentCalendar as any).mockResolvedValue([
      { type: 'SOCIAL_POST', id: 'p1', title: 'Hello reel', scheduledAt: '2026-07-10T09:00:00Z', status: 'SCHEDULED' },
    ]);
    renderPage();
    expect(await screen.findByText('Hello reel')).toBeInTheDocument();
    expect(screen.getByText('SCHEDULED')).toBeInTheDocument();
  });
});
