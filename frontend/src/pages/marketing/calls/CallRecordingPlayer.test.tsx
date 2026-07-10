import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CallRecordingPlayer from './CallRecordingPlayer';

const getCallRecording = vi.fn();

vi.mock('../../../features/marketing/api/voice-ai.service', async () => {
  const actual = await vi.importActual<
    typeof import('../../../features/marketing/api/voice-ai.service')
  >('../../../features/marketing/api/voice-ai.service');
  return {
    ...actual,
    getCallRecording: (...a: unknown[]) => getCallRecording(...a),
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

describe('CallRecordingPlayer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders an <audio> element with the resolved url as its src', async () => {
    getCallRecording.mockResolvedValue({ url: 'https://cdn.example.com/netgsm-recordings/ws-1/call-1.mp3' });
    const { container } = render(<CallRecordingPlayer callId="call-1" />, { wrapper });

    await waitFor(() => expect(getCallRecording).toHaveBeenCalledWith('call-1'));
    const audio = await waitFor(() => {
      const el = container.querySelector('audio');
      expect(el).not.toBeNull();
      return el as HTMLAudioElement;
    });
    expect(audio).toHaveAttribute('src', 'https://cdn.example.com/netgsm-recordings/ws-1/call-1.mp3');
    expect(audio).toHaveAttribute('controls');
  });

  it('renders nothing when the route 404s (no recording available)', async () => {
    getCallRecording.mockRejectedValue({ response: { status: 404 } });
    const { container } = render(<CallRecordingPlayer callId="call-2" />, { wrapper });

    await waitFor(() => expect(getCallRecording).toHaveBeenCalledWith('call-2'));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
