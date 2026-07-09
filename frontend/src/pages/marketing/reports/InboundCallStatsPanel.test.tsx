import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InboundCallStatsPanel from './InboundCallStatsPanel';

const getTelephonyStatistics = vi.fn();

vi.mock('../../../features/marketing/api/telephony-statistics.service', async () => {
  const actual = await vi.importActual<
    typeof import('../../../features/marketing/api/telephony-statistics.service')
  >('../../../features/marketing/api/telephony-statistics.service');
  return {
    ...actual,
    getTelephonyStatistics: (...a: unknown[]) => getTelephonyStatistics(...a),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('InboundCallStatsPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders answered/abandoned/avg-wait from the summary', async () => {
    getTelephonyStatistics.mockResolvedValue({
      from: '2026-07-01',
      to: '2026-07-07',
      clamped: false,
      ok: true,
      daily: [],
      summary: { answered: 42, abandoned: 3, avgWaitSec: 95 },
    });
    render(<InboundCallStatsPanel />, { wrapper });

    await waitFor(() => expect(getTelephonyStatistics).toHaveBeenCalled());
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('1:35')).toBeInTheDocument();
    expect(screen.queryByText(/production server IP/)).not.toBeInTheDocument();
  });

  it('renders zeros/dash when the daily aggregates are empty', async () => {
    getTelephonyStatistics.mockResolvedValue({
      from: '2026-07-01',
      to: '2026-07-07',
      clamped: false,
      ok: true,
      daily: [],
      summary: { answered: 0, abandoned: 0, avgWaitSec: null },
    });
    render(<InboundCallStatsPanel />, { wrapper });

    await waitFor(() => expect(getTelephonyStatistics).toHaveBeenCalled());
    expect(await screen.findByText('—')).toBeInTheDocument();
  });

  it('shows the off-prod/allow-list note when the response carries a NetGSM error code', async () => {
    getTelephonyStatistics.mockResolvedValue({
      from: '2026-07-01',
      to: '2026-07-07',
      clamped: false,
      ok: false,
      code: '30',
      daily: [],
      summary: { answered: 0, abandoned: 0, avgWaitSec: null },
    });
    render(<InboundCallStatsPanel />, { wrapper });

    expect(
      await screen.findByText(/production server IP \(NetGSM allow-list\)/),
    ).toBeInTheDocument();
  });

  it('shows a quiet error line when the request fails (e.g. netsantral not configured)', async () => {
    getTelephonyStatistics.mockRejectedValue({ response: { status: 503 } });
    render(<InboundCallStatsPanel />, { wrapper });

    expect(await screen.findByText('Could not load call statistics.')).toBeInTheDocument();
  });
});
