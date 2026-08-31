import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CallAnalysisPanel from './CallAnalysisPanel';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

const getCallAnalysis = vi.fn();
const runCallAnalysis = vi.fn();

vi.mock('../../../features/marketing/api/voice-ai.service', async () => {
  const actual = await vi.importActual<
    typeof import('../../../features/marketing/api/voice-ai.service')
  >('../../../features/marketing/api/voice-ai.service');
  return {
    ...actual,
    getCallAnalysis: (...a: unknown[]) => getCallAnalysis(...a),
    runCallAnalysis: (...a: unknown[]) => runCallAnalysis(...a),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'tr' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('CallAnalysisPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a recording-required hint when no analysis and no recording', async () => {
    getCallAnalysis.mockResolvedValue({ status: 'NONE' });
    render(<CallAnalysisPanel callId="c1" hasRecording={false} />, { wrapper });
    expect(await screen.findByText(/a call recording is required/i)).toBeInTheDocument();
    // No analyse button when there's no recording.
    expect(screen.queryByRole('button', { name: /analyse/i })).not.toBeInTheDocument();
  });

  it('shows an Analyse button when no analysis but a recording exists, and runs it', async () => {
    getCallAnalysis.mockResolvedValue({ status: 'NONE' });
    runCallAnalysis.mockResolvedValue({ status: 'OK' });
    render(<CallAnalysisPanel callId="c1" hasRecording />, { wrapper });
    const btn = await screen.findByRole('button', { name: /analyse/i });
    await userEvent.click(btn);
    await waitFor(() => expect(runCallAnalysis).toHaveBeenCalledWith('c1'));
  });

  /**
   * The repo's central rule, on the second component that had it collapsed.
   *
   * The panel used to read only `{ data, isLoading }`. On a failed fetch `data`
   * is `undefined`, `isCallAnalysis(undefined)` is false, and it fell straight
   * into the no-analysis branch — so "we could not find out" and "there is
   * nothing yet" rendered the SAME Analyse button. Pressing it was the only way
   * to tell the two apart, and on the failure it would fail again.
   *
   * Exactly the defect CallRecordingPlayer was fixed for in b56080c3, one file
   * over, and the treatment is deliberately the same shape.
   */
  it('says the analysis could not be LOADED rather than offering the Analyse button', async () => {
    getCallAnalysis.mockRejectedValue({ response: { status: 500 } });
    render(<CallAnalysisPanel callId="c1" hasRecording />, { wrapper });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Analysis could not be loaded');
    // The two states are DISTINGUISHABLE: the empty state's button is absent.
    expect(screen.queryByRole('button', { name: /analyse/i })).not.toBeInTheDocument();
  });

  /**
   * The pairing assertion. Each screen on its own could be anything; what the
   * fix is answerable for is that a reader can TELL THEM APART, which is the
   * one thing the pre-fix panel could not do — its two DOMs were identical.
   */
  it('does not render a failed load and an absent analysis as the same screen', async () => {
    // Both anchors are the GENERIC settled signal — a button, which the empty
    // state has (Analyse) and the failed state has (Try again). Anchoring the
    // failed render on `role="alert"` would make this test fail at the anchor
    // if the error branch went missing, and the point here is narrower and
    // sharper than that: the two DOMs must not be the same bytes. Before the
    // fix they were exactly that.
    getCallAnalysis.mockResolvedValue({ status: 'NONE' });
    const empty = render(<CallAnalysisPanel callId="c1" hasRecording />, { wrapper });
    await empty.findByRole('button');
    const emptyHtml = empty.container.innerHTML;
    empty.unmount();

    getCallAnalysis.mockRejectedValue({ response: { status: 500 } });
    const failed = render(<CallAnalysisPanel callId="c1" hasRecording />, { wrapper });
    await failed.findByRole('button');

    expect(failed.container.innerHTML).not.toEqual(emptyHtml);
  });

  it('offers a retry, because a failed read is a thing you can try again', async () => {
    getCallAnalysis.mockRejectedValue({ response: { status: 503 } });
    render(<CallAnalysisPanel callId="c1" hasRecording />, { wrapper });

    // Anchor on the failure first: without it the retry lookup below could
    // resolve against a component that has not settled.
    await screen.findByRole('alert');
    const retry = await screen.findByRole('button', { name: /try again/i });

    getCallAnalysis.mockResolvedValue({ status: 'NONE' });
    await userEvent.click(retry);

    await waitFor(() => expect(getCallAnalysis).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: /analyse/i })).toBeInTheDocument();
  });

  /**
   * A network failure carries no `response` at all — the case most likely to be
   * mistaken for an empty answer by a check written the other way round.
   */
  it('treats a response-less failure as a failure, not as an absent analysis', async () => {
    getCallAnalysis.mockRejectedValue(new Error('Network Error'));
    render(<CallAnalysisPanel callId="c1" hasRecording />, { wrapper });

    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /analyse/i })).not.toBeInTheDocument();
  });

  it('renders summary, sentiment, score, action items and topics', async () => {
    getCallAnalysis.mockResolvedValue({
      id: 'a1',
      salesCallId: 'c1',
      transcript: 't',
      language: 'tr',
      summary: 'Müşteri fiyat sordu',
      sentiment: 'POSITIVE',
      score: 82,
      actionItems: ['Teklif gönder', 'Tekrar ara'],
      topics: ['fiyat', 'demo'],
      sttProvider: 'deepgram',
      createdAt: '2026-06-25T00:00:00Z',
    });
    render(<CallAnalysisPanel callId="c1" hasRecording />, { wrapper });
    expect(await screen.findByText('Müşteri fiyat sordu')).toBeInTheDocument();
    // The i18n mock returns the fallback (a.sentiment) for the sentiment label.
    expect(screen.getByText('POSITIVE')).toBeInTheDocument();
    expect(screen.getByText(/82\/100/)).toBeInTheDocument();
    expect(screen.getByText('Teklif gönder')).toBeInTheDocument();
    expect(screen.getByText('fiyat')).toBeInTheDocument();
  });
});
