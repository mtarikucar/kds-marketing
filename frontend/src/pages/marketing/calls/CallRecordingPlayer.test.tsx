import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  /**
   * The repo's central rule, on the one component that had it backwards.
   *
   * 404 means "this call has no recording" and rendering nothing is the honest
   * answer to it. Every OTHER failure — a 500, an expired provider token, the
   * network — means "we do not know", and until now it rendered identically:
   * silence. A rep looking for the call they need to hear was told, in the
   * same wordless way, that it does not exist.
   */
  it('says a recording could not be LOADED rather than showing the 404 silence', async () => {
    getCallRecording.mockRejectedValue({ response: { status: 500 }, message: 'boom' });
    const { findByRole, container } = render(<CallRecordingPlayer callId="call-3" />, { wrapper });

    const alert = await findByRole('alert');
    expect(alert).toHaveTextContent('Recording could not be loaded');
    // And it is NOT the "no recording" silence, nor a player pointed at nothing.
    expect(container).not.toBeEmptyDOMElement();
    expect(container.querySelector('audio')).toBeNull();
  });

  it('offers a retry, because a failed load is a thing you can try again', async () => {
    getCallRecording.mockRejectedValue({ response: { status: 503 } });
    const { findByRole } = render(<CallRecordingPlayer callId="call-4" />, { wrapper });

    // Anchor on the failure first: without it the absence assertions below
    // would pass against a still-loading component.
    await findByRole('alert');
    const retry = await findByRole('button', { name: /try again/i });

    getCallRecording.mockResolvedValue({ url: 'https://cdn.example.com/r.mp3' });
    const user = userEvent.setup();
    await user.click(retry);

    await waitFor(() => expect(getCallRecording).toHaveBeenCalledTimes(2));
  });

  /**
   * A network failure has no `response` at all. It is the case most likely to
   * be read as a 404 by a `status !== 404` check written the other way round.
   */
  it('treats a response-less failure as a failure, not as an absent recording', async () => {
    getCallRecording.mockRejectedValue(new Error('Network Error'));
    const { findByRole } = render(<CallRecordingPlayer callId="call-5" />, { wrapper });

    await findByRole('alert');
  });
});
