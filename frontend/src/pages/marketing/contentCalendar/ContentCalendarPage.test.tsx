import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('ContentCalendarPage (month grid)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-10T12:00:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('renders the month grid with the type legend + Today control', async () => {
    (svc.listContentCalendar as any).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Social post')).toBeInTheDocument();
    expect(screen.getByText('Campaign content')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Today/ })).toBeInTheDocument();
  });

  it('shows a scheduled item inside its day cell', async () => {
    (svc.listContentCalendar as any).mockResolvedValue([
      { type: 'SOCIAL_POST', id: 'p1', title: 'Hello reel', scheduledAt: '2026-07-14T09:00:00', status: 'SCHEDULED' },
    ]);
    renderPage();
    expect(await screen.findByText('Hello reel')).toBeInTheDocument();
  });

  it('queries the visible grid range (padded month bounds)', async () => {
    (svc.listContentCalendar as any).mockResolvedValue([]);
    renderPage();
    await screen.findByText('Social post');
    const [from, to] = (svc.listContentCalendar as any).mock.calls[0];
    expect(from <= '2026-07-01').toBe(true);
    expect(to >= '2026-07-31').toBe(true);
  });
});
