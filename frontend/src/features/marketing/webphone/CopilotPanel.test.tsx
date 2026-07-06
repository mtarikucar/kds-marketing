import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CopilotPanel from './CopilotPanel';

const getCopilotSuggestions = vi.fn();

vi.mock('../api/voice-ai.service', async () => {
  const actual = await vi.importActual<typeof import('../api/voice-ai.service')>(
    '../api/voice-ai.service',
  );
  return { ...actual, getCopilotSuggestions: (...a: unknown[]) => getCopilotSuggestions(...a) };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'tr' },
  }),
}));

describe('CopilotPanel (fallback, no SpeechRecognition)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure SpeechRecognition is unavailable so the textarea fallback renders.
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  });

  it('renders the textarea fallback and fetches suggestions on click', async () => {
    getCopilotSuggestions.mockResolvedValue({
      suggestions: ['Fiyatımız uygundur', 'Demo planlayalım', 'Bütçenizi öğrenebilir miyim?'],
      summary: 'Müşteri fiyat odaklı',
    });
    render(<CopilotPanel />);

    const textarea = screen.getByPlaceholderText(/paste the call transcript/i);
    await userEvent.type(textarea, 'Müşteri fiyat sordu');
    await userEvent.click(screen.getByRole('button', { name: /get suggestions/i }));

    await waitFor(() =>
      expect(getCopilotSuggestions).toHaveBeenCalledWith({
        agentProfileId: null,
        transcript: 'Müşteri fiyat sordu',
      }),
    );
    expect(await screen.findByText('Fiyatımız uygundur')).toBeInTheDocument();
    expect(screen.getByText(/Müşteri fiyat odaklı/)).toBeInTheDocument();
    // Caps at 3 suggestions.
    expect(screen.getByText('Bütçenizi öğrenebilir miyim?')).toBeInTheDocument();
  });

  it('does not call the API for an empty transcript', async () => {
    render(<CopilotPanel />);
    await userEvent.click(screen.getByRole('button', { name: /get suggestions/i }));
    expect(getCopilotSuggestions).not.toHaveBeenCalled();
  });
});
