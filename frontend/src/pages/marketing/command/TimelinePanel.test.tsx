import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TimelinePanel } from './TimelinePanel';
import * as timelineService from '../../../features/marketing/api/homeTimeline.service';
import type { HomeTimeline } from '../../../features/marketing/api/homeTimeline.service';

vi.mock('../../../features/marketing/api/homeTimeline.service');

const getHomeTimeline = vi.mocked(timelineService.getHomeTimeline);

const timeline = (over: Partial<HomeTimeline> = {}): HomeTimeline => ({
  from: '2026-08-29T00:00:00Z',
  to: '2026-09-05T00:00:00Z',
  items: [],
  unread: [],
  truncated: [],
  ...over,
});

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (ui: ReactNode) => render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  return wrap(<TimelinePanel />);
}

beforeEach(() => {
  vi.resetAllMocks();
  getHomeTimeline.mockResolvedValue(timeline());
});

describe('TimelinePanel', () => {
  it('separates machine work from human work', async () => {
    getHomeTimeline.mockResolvedValue(
      timeline({
        items: [
          { kind: 'system', id: 'research-nightly', title: 'research-nightly', at: '2026-08-29T03:00:00Z' },
          { kind: 'task', id: 't1', title: 'Hasan Usta ara', at: '2026-08-29T09:00:00Z' },
        ],
      }),
    );

    renderPanel();

    expect(await screen.findByText('Hasan Usta ara')).toBeInTheDocument();
    expect(screen.getByTestId('tl-system-research-nightly')).toHaveAttribute('data-kind', 'system');
    expect(screen.getByTestId('tl-task-t1')).toHaveAttribute('data-kind', 'task');
  });

  // Separating the two lanes by NAME is only half the requirement; the point is
  // that machine work is present without competing with the operator's own. Four
  // sources at equal weight is the unreadable column this panel exists to avoid.
  //
  // Asserted on `data-weight` rather than on the class string: a Tailwind retune
  // that swaps `opacity-60` for a token would fail a class assertion while the
  // requirement still holds (a false alarm), whereas collapsing the two branches
  // into one — the real regression — fails this.
  it('renders machine work recessively so it does not compete with human work', async () => {
    getHomeTimeline.mockResolvedValue(
      timeline({
        items: [
          { kind: 'system', id: 'research-nightly', title: 'research-nightly', at: '2026-08-29T03:00:00Z' },
          { kind: 'task', id: 't1', title: 'Hasan Usta ara', at: '2026-08-29T09:00:00Z' },
          { kind: 'appointment', id: 'b1', title: 'Showroom ziyareti', at: '2026-08-29T11:00:00Z' },
          { kind: 'campaign', id: 'c1', title: 'Eylül indirimi', at: '2026-08-30T08:00:00Z' },
        ],
      }),
    );

    renderPanel();

    expect(await screen.findByTestId('tl-system-research-nightly')).toHaveAttribute(
      'data-weight',
      'recessive',
    );
    // Every non-system lane carries the operator's weight, not just tasks.
    for (const testId of ['tl-task-t1', 'tl-appointment-b1', 'tl-campaign-c1']) {
      expect(screen.getByTestId(testId)).toHaveAttribute('data-weight', 'normal');
    }
  });

  it('names a source it could not read', async () => {
    getHomeTimeline.mockResolvedValue(timeline({ unread: ['görevler'] }));
    renderPanel();
    const unread = await screen.findByTestId('tl-unread');
    expect(unread).toHaveTextContent(/görevler/);
    // Both signals appear only AFTER the fetch, and again on the 60s refetch of
    // an already-rendered panel. Without a live region a screen-reader user is
    // simply never told the list they are reading is incomplete.
    expect(unread).toHaveAttribute('role', 'status');
  });

  it('names a source that had more than it could show', async () => {
    getHomeTimeline.mockResolvedValue(timeline({ truncated: ['kampanyalar'] }));
    renderPanel();
    const truncated = await screen.findByTestId('tl-truncated');
    expect(truncated).toHaveTextContent(/kampanyalar/);
    expect(truncated).toHaveAttribute('role', 'status');
  });

  // The two signals mean different things — "could not read it" vs "read it,
  // there was more". Collapsing them into one line would hide a broken query
  // behind a capped one, so both must survive being present together.
  it('keeps the unreadable and the capped apart when both happen at once', async () => {
    getHomeTimeline.mockResolvedValue(
      timeline({ unread: ['görevler'], truncated: ['kampanyalar'] }),
    );
    renderPanel();

    const unread = await screen.findByTestId('tl-unread');
    const truncated = screen.getByTestId('tl-truncated');
    expect(unread).toHaveTextContent(/görevler/);
    expect(unread).not.toHaveTextContent(/kampanyalar/);
    expect(truncated).toHaveTextContent(/kampanyalar/);
    expect(truncated).not.toHaveTextContent(/görevler/);
    // Two live regions, not one merged line.
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });

  it('says the calendar is empty rather than showing a blank box', async () => {
    renderPanel();
    expect(await screen.findByText(/Planlanmış bir şey yok/)).toBeInTheDocument();
  });

  // An empty calendar and a failed fetch look identical if the error is
  // swallowed — the whole point of the backend's per-source honesty.
  it('reports a failed fetch instead of an empty calendar', async () => {
    getHomeTimeline.mockRejectedValue(new Error('boom'));
    renderPanel();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/Planlanmış bir şey yok/)).not.toBeInTheDocument();
  });
});
