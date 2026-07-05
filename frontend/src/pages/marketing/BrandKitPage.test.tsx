import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BrandKitPage from './BrandKitPage';
import * as brandKitService from '../../features/marketing/api/brandKit.service';

vi.mock('../../features/marketing/api/brandKit.service', () => ({
  getBrandKit: vi.fn(),
  updateBrandKit: vi.fn(),
  uploadReferenceImage: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string) => def ?? key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const KIT = {
  id: 'bk-1', logoUrl: null, logoR2Key: null, palette: ['#1e40af'], tone: 'friendly',
  referenceImages: [], defaultHashtags: ['#jeeta'], defaultCta: 'Book now',
  createdAt: '', updatedAt: '',
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('BrandKitPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(brandKitService.getBrandKit).mockResolvedValue(KIT as never);
    vi.mocked(brandKitService.updateBrandKit).mockResolvedValue(KIT as never);
  });

  it('renders the heading and populates fields from getBrandKit', async () => {
    render(<BrandKitPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(await screen.findByDisplayValue('friendly')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Book now')).toBeInTheDocument();
  });

  it('embedded: skips its own page header (host page owns the header)', async () => {
    render(<BrandKitPage embedded />, { wrapper });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    // The body still renders normally.
    expect(await screen.findByDisplayValue('friendly')).toBeInTheDocument();
  });

  it('keeps unsaved edits when the query refetches (e.g. after a logo/reference upload)', async () => {
    // First load returns the kit; a later refetch returns a kit that differs only
    // in referenceImages (as an upload would) so react-query yields a fresh object.
    vi.mocked(brandKitService.getBrandKit).mockReset();
    vi.mocked(brandKitService.getBrandKit)
      .mockResolvedValueOnce(KIT as never)
      .mockResolvedValue({
        ...KIT,
        referenceImages: [{ url: 'u', r2Key: 'k', mime: 'image/png' }],
      } as never);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <BrandKitPage />
      </QueryClientProvider>,
    );

    const tone = await screen.findByDisplayValue('friendly');
    await userEvent.clear(tone);
    await userEvent.type(tone, 'bold and playful');

    // Simulate an upload's onSuccess invalidating + refetching the brand kit.
    await qc.invalidateQueries({ queryKey: ['marketing', 'brandKit'] });
    // Wait until the refetched data has rendered (the new reference image appears),
    // which guarantees the seeding effect had its chance to run against fresh data.
    await screen.findByAltText('reference');

    // The unsaved edit must survive the refetch (not be reset to server 'friendly').
    expect(screen.getByDisplayValue('bold and playful')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('friendly')).not.toBeInTheDocument();
  });

  it('saving sends the edited tone/cta/hashtags to updateBrandKit', async () => {
    render(<BrandKitPage />, { wrapper });
    const tone = await screen.findByDisplayValue('friendly');
    await userEvent.clear(tone);
    await userEvent.type(tone, 'bold and playful');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(brandKitService.updateBrandKit).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: 'bold and playful',
          defaultCta: 'Book now',
          defaultHashtags: ['#jeeta'],
        }),
      ),
    );
  });
});
