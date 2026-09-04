import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentLinePanel } from './ContentLinePanel';
import * as contentLine from '../../../features/marketing/api/contentLine.service';
import type {
  AnglePerformance,
  BatchSummary,
} from '../../../features/marketing/api/contentLine.service';

vi.mock('../../../features/marketing/api/contentLine.service');
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string | Record<string, unknown>, o?: Record<string, unknown>) => {
      const def = typeof d === 'string' ? d : '';
      const vars = (typeof d === 'string' ? o : (d as Record<string, unknown>)) ?? {};
      return def.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k] ?? ''));
    },
    i18n: { language: 'tr' },
  }),
}));

const listBatches = vi.mocked(contentLine.listBatches);
const getAnglePerformance = vi.mocked(contentLine.getAnglePerformance);
const planConcepts = vi.mocked(contentLine.planConcepts);

const COLD: AnglePerformance = { cold: true, angles: [], weights: {} };

const batch = (over: Partial<BatchSummary> = {}): BatchSummary => ({
  batchId: 'b1',
  sourceIdea: 'Rüzgarla yürüyen kinetik heykel',
  createdAt: '2026-09-01T10:00:00.000Z',
  concepts: { total: 5, awaitingReview: 5, approved: 0, discarded: 0 },
  production: { generating: 0, needsApproval: 0, scheduled: 0, published: 0, failed: 0 },
  reach: null,
  ...over,
});

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('ContentLinePanel', () => {
  it('keeps the batch cards when angle history breaks, and names the missing part', async () => {
    // The whole reason the two reads are separate calls. One broken query must
    // cost its own panel, not the studio: this repo has already shipped a
    // morning briefing that swallowed eight failures as zeroes, and a Takvim
    // view that rendered nothing behind 126 green tests.
    getAnglePerformance.mockRejectedValue(new Error('500'));
    listBatches.mockResolvedValue([batch()]);

    wrap(<ContentLinePanel onOpenBatch={vi.fn()} />);

    expect(await screen.findByText(/Rüzgarla yürüyen kinetik heykel/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Açı performansı okunamadı/)).toBeInTheDocument(),
    );
  });

  it('reports a failed batch read as a failure, not as "no batches yet"', async () => {
    getAnglePerformance.mockResolvedValue(COLD);
    listBatches.mockRejectedValue(new Error('500'));

    wrap(<ContentLinePanel onOpenBatch={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/Partiler okunamadı/)).toBeInTheDocument());
    expect(screen.queryByText(/Henüz parti yok/)).not.toBeInTheDocument();
  });

  it('shows the empty state when there genuinely are no batches', async () => {
    getAnglePerformance.mockResolvedValue(COLD);
    listBatches.mockResolvedValue([]);

    wrap(<ContentLinePanel onOpenBatch={vi.fn()} />);

    expect(await screen.findByText(/Henüz parti yok/)).toBeInTheDocument();
    expect(screen.queryByText(/Partiler okunamadı/)).not.toBeInTheDocument();
  });

  it('will not plan an empty idea', async () => {
    getAnglePerformance.mockResolvedValue(COLD);
    listBatches.mockResolvedValue([]);

    wrap(<ContentLinePanel onOpenBatch={vi.fn()} />);
    await screen.findByText(/Henüz parti yok/);

    // Planning spends AI and media credits. A button that fires on an empty
    // textarea buys a batch nobody asked for.
    expect(screen.getByRole('button', { name: /Konsept üret/ })).toBeDisabled();
  });

  it('plans the pasted idea and opens the batch it produced', async () => {
    getAnglePerformance.mockResolvedValue(COLD);
    listBatches.mockResolvedValue([]);
    planConcepts.mockResolvedValue({
      batchId: 'new-batch',
      sourceIdea: 'fikir',
      concepts: [],
      cold: true,
      weights: {},
    });
    const onOpenBatch = vi.fn();

    wrap(<ContentLinePanel onOpenBatch={onOpenBatch} />);
    await screen.findByText(/Henüz parti yok/);

    await userEvent.type(screen.getByLabelText(/Bir fikir yapıştır/), 'fikir');
    await userEvent.click(screen.getByRole('button', { name: /Konsept üret/ }));

    await waitFor(() => expect(planConcepts).toHaveBeenCalledWith({ idea: 'fikir' }));
    await waitFor(() => expect(onOpenBatch).toHaveBeenCalledWith('new-batch'));
  });

  it('says the batch was planned unguided when there was nothing to learn from', async () => {
    getAnglePerformance.mockResolvedValue(COLD);
    listBatches.mockResolvedValue([]);

    wrap(<ContentLinePanel onOpenBatch={vi.fn()} />);
    await screen.findByText(/Henüz parti yok/);

    // Cold is the live state today — zero connected accounts — so the composer
    // must not imply a weighting it does not have.
    expect(screen.queryByText(/Ölçülen açılara göre ağırlıklandırılacak/)).not.toBeInTheDocument();
  });
});
