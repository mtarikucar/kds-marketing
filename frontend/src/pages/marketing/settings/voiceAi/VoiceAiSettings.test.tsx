import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import VoiceAiSettings from './VoiceAiSettings';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const getVoiceAiStatus = vi.fn();
vi.mock('../../../../features/marketing/api/voice-ai.service', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../features/marketing/api/voice-ai.service')
  >('../../../../features/marketing/api/voice-ai.service');
  return { ...actual, getVoiceAiStatus: () => getVoiceAiStatus() };
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

describe('VoiceAiSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders each capability with on/off state and copy-able URLs', async () => {
    getVoiceAiStatus.mockResolvedValue({
      capabilities: { stt: true, bridge: false, netgsmIvr: false, copilot: true },
      urls: {
        bridge: 'https://app.example/api/public/voice-ai/llm/{channelId}/chat/completions',
        netgsmIvr: 'https://app.example/api/public/telephony/netgsm-ivr/{token}',
        copilotSuggest: 'https://app.example/api/marketing/voice-ai/copilot/suggest',
      },
    });
    render(<VoiceAiSettings />, { wrapper });

    // Heading present.
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    // The bridge URL template is surfaced.
    expect(
      await screen.findByText(/voice-ai\/llm\/\{channelId\}\/chat\/completions/),
    ).toBeInTheDocument();
    // On/off badges: STT on, bridge off → at least one "Açık" and one "Kapalı".
    expect(screen.getAllByText('Açık').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Kapalı').length).toBeGreaterThan(0);
  });
});
