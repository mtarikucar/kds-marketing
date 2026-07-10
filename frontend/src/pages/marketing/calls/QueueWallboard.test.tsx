import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import QueueWallboard from './QueueWallboard';

const getQueueStats = vi.fn();
const setAgentPresence = vi.fn();

vi.mock('../../../features/marketing/api/telephony-queue.service', async () => {
  const actual = await vi.importActual<
    typeof import('../../../features/marketing/api/telephony-queue.service')
  >('../../../features/marketing/api/telephony-queue.service');
  return {
    ...actual,
    getQueueStats: (...a: unknown[]) => getQueueStats(...a),
    // react-query v5 invokes mutationFn(variables, mutationFnContext) — only
    // forward the payload, matching the real function's one-argument signature.
    setAgentPresence: (payload: unknown) => setAgentPresence(payload),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('QueueWallboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders aggregate waiting/holdtime + per-agent state badges', async () => {
    getQueueStats.mockResolvedValue({
      queues: [
        {
          queue: '8508407303-queue-sales',
          waiting: 3,
          holdtimeSec: 90,
          agents: [
            { dahili: '101', state: 'available' },
            { dahili: '102', state: 'paused' },
          ],
        },
      ],
    });
    render(<QueueWallboard />, { wrapper });

    await waitFor(() => expect(getQueueStats).toHaveBeenCalled());
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('1:30')).toBeInTheDocument();
    expect(screen.getByText(/101/)).toBeInTheDocument();
    expect(screen.getByText(/102/)).toBeInTheDocument();
  });

  it('shows the empty state when there are no active queues', async () => {
    getQueueStats.mockResolvedValue({ queues: [] });
    render(<QueueWallboard />, { wrapper });

    await waitFor(() => expect(getQueueStats).toHaveBeenCalled());
    expect(
      await screen.findByText('No active queue yet — configure NetGSM Netsantral queues to see live stats here.'),
    ).toBeInTheDocument();
  });

  it('shows a quiet error line when the stats request fails (e.g. netsantral not configured)', async () => {
    getQueueStats.mockRejectedValue({ response: { status: 503 } });
    render(<QueueWallboard />, { wrapper });

    expect(await screen.findByText('Could not load queue stats.')).toBeInTheDocument();
  });

  it('clicking Available calls setAgentPresence with state:available (no reason)', async () => {
    getQueueStats.mockResolvedValue({ queues: [] });
    setAgentPresence.mockResolvedValue({ ok: true, state: 'available' });
    const user = userEvent.setup();
    render(<QueueWallboard />, { wrapper });

    await waitFor(() => expect(getQueueStats).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /Available/i }));

    await waitFor(() => expect(setAgentPresence).toHaveBeenCalledWith({ state: 'available' }));
  });

  it('clicking Break opens the reason dialog; picking a preset and confirming calls setAgentPresence with state:break + reason', async () => {
    getQueueStats.mockResolvedValue({ queues: [] });
    setAgentPresence.mockResolvedValue({ ok: true, state: 'break' });
    const user = userEvent.setup();
    render(<QueueWallboard />, { wrapper });

    await waitFor(() => expect(getQueueStats).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /Break/i }));

    expect(await screen.findByText('Take a break')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lunch' }));
    await user.click(screen.getByRole('button', { name: 'Start break' }));

    await waitFor(() =>
      expect(setAgentPresence).toHaveBeenCalledWith({ state: 'break', reason: 'Lunch' }),
    );
  });

  it('confirming a break with no reason picked sends reason:undefined (a default/no-reason break)', async () => {
    getQueueStats.mockResolvedValue({ queues: [] });
    setAgentPresence.mockResolvedValue({ ok: true, state: 'break' });
    const user = userEvent.setup();
    render(<QueueWallboard />, { wrapper });

    await waitFor(() => expect(getQueueStats).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /Break/i }));
    expect(await screen.findByText('Take a break')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start break' }));

    await waitFor(() =>
      expect(setAgentPresence).toHaveBeenCalledWith({ state: 'break', reason: undefined }),
    );
  });
});
