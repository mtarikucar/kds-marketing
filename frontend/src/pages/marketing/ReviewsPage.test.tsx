import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ReviewsPage from './ReviewsPage';
import marketingApi from '../../features/marketing/api/marketingApi';

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ReviewsPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mounts and renders the page heading', () => {
    render(<ReviewsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders the Review sources section', () => {
    render(<ReviewsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
  });

  it('renders an "Add" button for sources', () => {
    render(<ReviewsPage />, { wrapper });
    expect(screen.getByRole('button', { name: /add|reviews\.addSource/i })).toBeInTheDocument();
  });

  it('shows validation error when adding source with empty URL', async () => {
    render(<ReviewsPage />, { wrapper });
    // fill name only, leave URL empty
    const nameInput = screen.getByPlaceholderText(/name|reviews\.sourceName/i);
    await userEvent.type(nameInput, 'Google');
    await userEvent.click(screen.getByRole('button', { name: /add|reviews\.addSource/i }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  // Each review's "AI draft" button is a per-row action driven by the SHARED
  // draft mutation — its isPending/loading must be scoped by `variables === r.id`,
  // or drafting one review's reply freezes the AI-draft button on EVERY review row
  // (per-row loading bleed; the draft call takes seconds).
  it('drafting one review does not disable the AI-draft button on other reviews', async () => {
    (marketingApi.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url === '/reviews'
        ? Promise.resolve({
            data: [
              // PRIVATE_FEEDBACK renders the reply/AI-draft affordance per review.
              { id: 'rv1', status: 'PRIVATE_FEEDBACK', createdAt: '2026-01-01T00:00:00Z', rating: 5, text: 'Great' },
              { id: 'rv2', status: 'PRIVATE_FEEDBACK', createdAt: '2026-01-02T00:00:00Z', rating: 4, text: 'Good' },
            ],
          })
        : Promise.resolve({ data: [] }),
    );
    (marketingApi.post as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url.endsWith('/draft') ? new Promise(() => {}) : Promise.resolve({ data: {} }),
    );
    const user = userEvent.setup();
    render(<ReviewsPage />, { wrapper });

    const draftButtons = await screen.findAllByRole('button', { name: /ai draft/i });
    expect(draftButtons).toHaveLength(2);

    await user.click(draftButtons[0]); // draft for rv1 — stays in-flight

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /ai draft/i })[0]).toBeDisabled(),
    );
    // The OTHER review's AI-draft button must stay enabled.
    expect(screen.getAllByRole('button', { name: /ai draft/i })[1]).not.toBeDisabled();
  });

  // Same per-row bleed on the sources list: connecting one source must not disable
  // the Connect button on the other sources (shared connectSource mutation).
  it('connecting one review source does not disable the other sources’ Connect buttons', async () => {
    (marketingApi.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url === '/reviews/sources'
        ? Promise.resolve({
            data: [
              { id: 's1', name: 'Google', placeUrl: 'g', tokenSet: false },
              { id: 's2', name: 'Yelp', placeUrl: 'y', tokenSet: false },
            ],
          })
        : Promise.resolve({ data: [] }),
    );
    (marketingApi.post as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url.endsWith('/connect') ? new Promise(() => {}) : Promise.resolve({ data: {} }),
    );
    const user = userEvent.setup();
    render(<ReviewsPage />, { wrapper });

    const connectButtons = await screen.findAllByRole('button', { name: /connect/i });
    expect(connectButtons).toHaveLength(2);

    await user.click(connectButtons[0]); // connect s1 — stays in-flight

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /connect/i })[0]).toBeDisabled(),
    );
    expect(screen.getAllByRole('button', { name: /connect/i })[1]).not.toBeDisabled();
  });
});
