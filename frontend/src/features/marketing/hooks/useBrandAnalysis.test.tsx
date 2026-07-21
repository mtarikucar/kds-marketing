import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBrandAnalysis } from './useBrandAnalysis';
import * as brandBrainService from '../api/brandBrain.service';

vi.mock('../api/brandBrain.service', async () => {
  const actual = await vi.importActual<typeof import('../api/brandBrain.service')>(
    '../api/brandBrain.service',
  );
  return {
    ...actual,
    startBrandAnalysis: vi.fn(),
    getBrandAnalysisRun: vi.fn(),
    applyBrandAnalysis: vi.fn(),
  };
});

const READY_RUN = {
  id: 'run1',
  status: 'READY_FOR_REVIEW' as const,
  inputs: {},
  draft: {
    profile: { brandName: 'Acme' },
    researchProfile: {},
    brandKitHints: {},
    knowledgeDocs: [],
  },
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useBrandAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(brandBrainService.startBrandAnalysis).mockResolvedValue({ runId: 'run1' });
    vi.mocked(brandBrainService.getBrandAnalysisRun).mockResolvedValue(READY_RUN);
    vi.mocked(brandBrainService.applyBrandAnalysis).mockResolvedValue({ applied: true });
  });

  it('starts a run, seeds runId, and polls until READY_FOR_REVIEW', async () => {
    const { result } = renderHook(() => useBrandAnalysis(), { wrapper });

    result.current.start.mutate({ websiteUrl: 'https://x.com' });

    await waitFor(() => expect(result.current.runId).toBe('run1'));
    await waitFor(() => expect(result.current.run.data?.status).toBe('READY_FOR_REVIEW'));

    expect(brandBrainService.startBrandAnalysis).toHaveBeenCalledWith({
      websiteUrl: 'https://x.com',
    });
    expect(brandBrainService.getBrandAnalysisRun).toHaveBeenCalledWith('run1');
    // Terminal status → polling must stop.
    expect(result.current.isPolling).toBe(false);
  });

  it('observes an intermediate RUNNING status before polling stops at READY_FOR_REVIEW', async () => {
    // Real 3s refetchInterval + follow-up assertions need more than the 5s default.
    const RUNNING_RUN = {
      id: 'run1',
      status: 'RUNNING' as const,
      inputs: {},
      draft: null,
    };
    vi.mocked(brandBrainService.getBrandAnalysisRun)
      .mockResolvedValueOnce(RUNNING_RUN)
      .mockResolvedValue(READY_RUN);

    const { result } = renderHook(() => useBrandAnalysis(), { wrapper });

    result.current.start.mutate({ websiteUrl: 'https://x.com' });

    await waitFor(() => expect(result.current.runId).toBe('run1'));

    // First fetch resolves RUNNING — the hook must still be polling.
    await waitFor(() => expect(result.current.run.data?.status).toBe('RUNNING'));
    expect(result.current.isPolling).toBe(true);

    // The 3s refetchInterval fires a second fetch, which resolves READY_FOR_REVIEW.
    await waitFor(() => expect(result.current.run.data?.status).toBe('READY_FOR_REVIEW'), {
      timeout: 5000,
    });
    expect(result.current.isPolling).toBe(false);

    const callsAtReady = vi.mocked(brandBrainService.getBrandAnalysisRun).mock.calls.length;
    expect(callsAtReady).toBeGreaterThanOrEqual(2);

    // Polling has stopped: no further calls should accrue after READY.
    await new Promise((r) => setTimeout(r, 100));
    expect(vi.mocked(brandBrainService.getBrandAnalysisRun).mock.calls.length).toBe(callsAtReady);
  }, 8000);

  it('applies the run via applyBrandAnalysis', async () => {
    const { result } = renderHook(() => useBrandAnalysis(), { wrapper });

    result.current.apply.mutate({ runId: 'run1' });

    await waitFor(() => expect(result.current.apply.isSuccess).toBe(true));

    expect(brandBrainService.applyBrandAnalysis).toHaveBeenCalledWith('run1', undefined);
  });
});
