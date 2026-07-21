import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import BrandProfileEditor from './BrandProfileEditor';
import * as brandBrainService from '../../../features/marketing/api/brandBrain.service';

vi.mock('../../../features/marketing/api/brandBrain.service', async () => {
  const actual = await vi.importActual<typeof import('../../../features/marketing/api/brandBrain.service')>(
    '../../../features/marketing/api/brandBrain.service',
  );
  return {
    ...actual,
    getBrandProfile: vi.fn(),
    putBrandProfile: vi.fn(),
  };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string) => (typeof def === 'string' ? def : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PROFILE = {
  id: 'bp-1',
  brandName: 'Jeeta',
  tagline: 'Fresh, fast, local',
  description: 'A neighborhood grocery brand.',
  valueProps: ['fast', 'cheap'],
  toneWords: ['friendly', 'direct'],
  voiceGuide: 'Warm but concise.',
  icpDescription: 'Busy urban shoppers.',
  audienceObjections: ['too far', 'too pricey'],
  status: 'DRAFT' as const,
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('BrandProfileEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(brandBrainService.getBrandProfile).mockResolvedValue(PROFILE as never);
    vi.mocked(brandBrainService.putBrandProfile).mockResolvedValue({
      ...PROFILE,
      status: 'ACTIVE',
    } as never);
  });

  it('loads an existing profile and populates the fields, one value per line for arrays', async () => {
    render(<BrandProfileEditor />, { wrapper });

    expect(await screen.findByDisplayValue('Jeeta')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Fresh, fast, local')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A neighborhood grocery brand.')).toBeInTheDocument();
    // Testing Library's default text normalizer collapses newlines to spaces,
    // so assert these multiline (one-item-per-line) textareas via their raw
    // .value instead of getByDisplayValue.
    expect(screen.getByLabelText(/value propositions/i)).toHaveValue('fast\ncheap');
    expect(screen.getByLabelText(/tone words/i)).toHaveValue('friendly\ndirect');
    expect(screen.getByLabelText(/audience objections/i)).toHaveValue('too far\ntoo pricey');
    expect(screen.getByDisplayValue('Warm but concise.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Busy urban shoppers.')).toBeInTheDocument();

    // DRAFT profile loads with the grounding switch off.
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('edits brandName, activates grounding, and saves the expected payload + success toast', async () => {
    render(<BrandProfileEditor />, { wrapper });

    const nameInput = await screen.findByDisplayValue('Jeeta');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Jeeta Market');

    await userEvent.click(screen.getByRole('switch'));

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(brandBrainService.putBrandProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          brandName: 'Jeeta Market',
          valueProps: ['fast', 'cheap'],
          toneWords: ['friendly', 'direct'],
          audienceObjections: ['too far', 'too pricey'],
          status: 'ACTIVE',
        }),
      ),
    );

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });
});
