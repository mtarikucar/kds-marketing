import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LearnedPanel } from './LearnedPanel';
import * as contentLine from '../../../features/marketing/api/contentLine.service';
import type { AnglePerformance } from '../../../features/marketing/api/contentLine.service';

vi.mock('../../../features/marketing/api/contentLine.service');

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

const getAnglePerformance = vi.mocked(contentLine.getAnglePerformance);

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{children}</QueryClientProvider>);
}

const perf = (over: Partial<AnglePerformance> = {}): AnglePerformance => ({
  cold: false,
  angles: [],
  weights: {},
  ...over,
});

const angle = (over: Partial<AnglePerformance['angles'][number]> = {}) => ({
  angle: 'engineering',
  posts: 5,
  impressions: 10_000,
  engagements: 1_000,
  rate: 0.1,
  insufficient: false,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('LearnedPanel', () => {
  it('says there is no data yet rather than showing an empty scoreboard', async () => {
    // Today's live state: zero connected accounts, so nothing has ever been
    // published. "No signal yet" and "measured, everything scored nothing" must
    // not render the same.
    getAnglePerformance.mockResolvedValue(perf({ cold: true }));

    wrap(<LearnedPanel />);

    expect(await screen.findByText(/Henüz yayınlanmış içerik yok/)).toBeInTheDocument();
  });

  it('shows a measured angle with its rate', async () => {
    getAnglePerformance.mockResolvedValue(
      perf({ angles: [angle()], weights: { engineering: 1 } }),
    );

    wrap(<LearnedPanel />);

    expect(await screen.findByText('engineering')).toBeInTheDocument();
    expect(screen.getByText('%10')).toBeInTheDocument();
    expect(screen.getByText('5 gönderi')).toBeInTheDocument();
  });

  it('labels a thin angle instead of ranking it', async () => {
    getAnglePerformance.mockResolvedValue(
      perf({ angles: [angle({ angle: 'lucky', posts: 1, rate: 0.9, insufficient: true })] }),
    );

    wrap(<LearnedPanel />);

    expect(await screen.findByText('yeterli veri yok')).toBeInTheDocument();
    // The flukiest possible rate must not be printed as a score.
    expect(screen.queryByText('%90')).not.toBeInTheDocument();
  });

  it('treats an unmeasurable rate as unmeasured, not as zero', async () => {
    // impressions 0 → rate null. A 0% bar would claim a measurement nobody took.
    getAnglePerformance.mockResolvedValue(
      perf({ angles: [angle({ impressions: 0, engagements: 0, rate: null })] }),
    );

    wrap(<LearnedPanel />);

    expect(await screen.findByText('yeterli veri yok')).toBeInTheDocument();
    expect(screen.queryByText('%0')).not.toBeInTheDocument();
  });

  it('reports a failure as a failure, not as an empty panel', async () => {
    getAnglePerformance.mockRejectedValue(new Error('500'));

    wrap(<LearnedPanel />);

    await waitFor(() =>
      expect(screen.getByText(/Açı performansı okunamadı/)).toBeInTheDocument(),
    );
    // And it must say the rest of the screen survives — an error here is not an
    // outage of the studio.
    expect(screen.getByText(/yalnızca bu bölüm eksik/)).toBeInTheDocument();
  });
});
