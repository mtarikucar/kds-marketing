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
