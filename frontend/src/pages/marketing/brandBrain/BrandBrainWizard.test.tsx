import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BrandBrainWizard, { ANALYZE_TIMEOUT_MS } from './BrandBrainWizard';
import * as svc from '../../../features/marketing/api/brandBrain.service';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string } | string) =>
      typeof o === 'string' ? o : (o?.defaultValue ?? k),
  }),
}));
vi.mock('../../../features/marketing/api/brandBrain.service', async () => {
  const actual = await vi.importActual<typeof import('../../../features/marketing/api/brandBrain.service')>(
    '../../../features/marketing/api/brandBrain.service',
  );
  return {
    ...actual,
    startBrandAnalysis: vi.fn(),
    getBrandAnalysisRun: vi.fn(),
    applyBrandAnalysis: vi.fn(),
  };
});

// The draft carries everything an apply must preserve (G4): researchProfile,
// brandKitHints and knowledgeDocs ride along even though the wizard only lets
// the operator edit a handful of `profile` fields.
const DRAFT = {
  profile: { brandName: 'Acme', description: 'We sell X', valueProps: ['fast'], toneWords: ['warm'] },
  researchProfile: { businessTypes: ['cafe'], icpDescription: 'SMB cafes' },
  brandKitHints: { tone: 'warm' },
  knowledgeDocs: [{ title: 'About', content: '...' }],
};

const READY_RUN = {
  id: 'run1',
  status: 'READY_FOR_REVIEW' as const,
  inputs: {},
  draft: DRAFT,
};

function renderWizard(onDone = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrandBrainWizard onDone={onDone} />
    </QueryClientProvider>,
  );
}

describe('BrandBrainWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(svc.startBrandAnalysis).mockResolvedValue({ runId: 'run1' });
    vi.mocked(svc.getBrandAnalysisRun).mockResolvedValue(READY_RUN);
    vi.mocked(svc.applyBrandAnalysis).mockResolvedValue({ applied: true });
  });

  it('starts a run from a website URL, then applies the full draft on review (G4: knowledgeDocs survives)', async () => {
    renderWizard();

    fireEvent.change(screen.getByLabelText(/website url/i), { target: { value: 'https://acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: /analyze/i }));

    await waitFor(() =>
      expect(svc.startBrandAnalysis).toHaveBeenCalledWith(
        expect.objectContaining({ websiteUrl: 'https://acme.com' }),
      ),
    );

    // Review step renders once the run reaches READY_FOR_REVIEW, seeded from the draft.
    await waitFor(() => expect(screen.getByDisplayValue('Acme')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => expect(svc.applyBrandAnalysis).toHaveBeenCalled());
    const [runIdArg, draftArg] = vi.mocked(svc.applyBrandAnalysis).mock.calls[0];
    expect(runIdArg).toBe('run1');
    // G4 — the FULL draft round-trips: knowledgeDocs (the seeded KB) must survive
    // an apply even though the wizard only edits `profile` fields.
    expect(draftArg?.knowledgeDocs).toHaveLength(1);
    expect(draftArg?.knowledgeDocs?.[0]).toEqual({ title: 'About', content: '...' });
    expect(draftArg?.researchProfile).toEqual(DRAFT.researchProfile);
    expect(draftArg?.brandKitHints).toEqual(DRAFT.brandKitHints);
    expect(draftArg?.profile.brandName).toBe('Acme');

    // Regression: after apply succeeds, the wizard must advance past the
    // review step to the terminal "done" step (the run's cached status
    // flips to APPLIED so `step` recomputes) — not stay stuck on review.
    await waitFor(() => expect(screen.getByRole('button', { name: /finish/i })).toBeInTheDocument());
  });

  it('shows an error + Start over affordance when the run ends FAILED (no AI/providers configured), and never applies', async () => {
    vi.mocked(svc.getBrandAnalysisRun).mockResolvedValue({
      id: 'run1',
      status: 'FAILED',
      inputs: {},
      draft: null,
      error: 'AI is not configured',
    });

    renderWizard();

    fireEvent.change(screen.getByLabelText(/website url/i), { target: { value: 'https://acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: /analyze/i }));

    // Failure surface renders — error text + a "Start over" affordance, not a
    // blank/broken review.
    await waitFor(() => expect(screen.getByText('AI is not configured')).toBeInTheDocument());
    const startOverButton = screen.getByRole('button', { name: /start over/i });
    expect(startOverButton).toBeInTheDocument();

    expect(svc.applyBrandAnalysis).not.toHaveBeenCalled();

    // Clicking "Start over" resets the wizard back to the sources step.
    fireEvent.click(startOverButton);
    expect(screen.getByLabelText(/website url/i)).toBeInTheDocument();
  });

  describe('analyzing timeout (F1: crash-recovery escape hatch)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows the timeout failure surface + Start over if analysis never reaches a terminal status, and never applies', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.mocked(svc.getBrandAnalysisRun).mockResolvedValue({
        id: 'run1',
        status: 'RUNNING',
        inputs: {},
        draft: null,
      });

      renderWizard();

      fireEvent.change(screen.getByLabelText(/website url/i), { target: { value: 'https://acme.com' } });
      fireEvent.click(screen.getByRole('button', { name: /analyze/i }));

      await waitFor(() => expect(svc.startBrandAnalysis).toHaveBeenCalled());
      // Still analyzing — spinner surface, no timeout copy yet.
      expect(screen.getByText(/analyzing your brand/i)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ANALYZE_TIMEOUT_MS + 1000);
      });

      expect(screen.getByText(/taking longer than expected/i)).toBeInTheDocument();
      const startOverButton = screen.getByRole('button', { name: /start over/i });
      expect(startOverButton).toBeInTheDocument();
      expect(svc.applyBrandAnalysis).not.toHaveBeenCalled();

      fireEvent.click(startOverButton);
      expect(screen.getByLabelText(/website url/i)).toBeInTheDocument();
    });
  });
});
