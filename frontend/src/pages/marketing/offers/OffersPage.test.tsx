import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import OffersPage from './OffersPage';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

// Suppress i18next console noise
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

const EMPTY = { data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } } };
const DRAFT_OFFER = {
  id: 'o1',
  leadId: 'l1',
  status: 'DRAFT',
  customPrice: '199.00',
  discount: null,
  trialDays: null,
  validUntil: null,
  notes: null,
  createdAt: '2026-06-01T00:00:00Z',
  lead: { id: 'l1', businessName: 'Acme', contactPerson: 'Jane' },
  createdBy: { id: 'u1', firstName: 'A', lastName: 'B' },
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('OffersPage', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({ data: { id: '1' } });
    // Default: empty list (the original tests don't depend on rows).
    get.mockResolvedValue(EMPTY);
  });

  it('mounts and renders the page header heading', () => {
    render(<OffersPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders a "New offer" button', () => {
    render(<OffersPage />, { wrapper });
    expect(
      screen.getByRole('button', { name: /new offer|offers\.createButton/i }),
    ).toBeInTheDocument();
  });

  it('opens the create offer dialog when "New offer" is clicked', async () => {
    render(<OffersPage />, { wrapper });
    const newOfferBtn = screen.getByRole('button', { name: /new offer|offers\.createButton/i });
    await userEvent.click(newOfferBtn);
    const dialogTitle = await screen.findByRole('heading', { level: 2 });
    expect(dialogTitle).toBeInTheDocument();
  });

  it('shows validation error when submitting empty form', async () => {
    render(<OffersPage />, { wrapper });
    const newOfferBtn = screen.getByRole('button', { name: /new offer|offers\.createButton/i });
    await userEvent.click(newOfferBtn);
    const submitBtns = await screen.findAllByRole('button', { name: /create|save|common\./i });
    const submitBtn = submitBtns.find((b) => b.getAttribute('type') === 'submit') ?? submitBtns[submitBtns.length - 1];
    await userEvent.click(submitBtn);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  // Regression: sending an offer transmits a price quote to the customer and is
  // irreversible, so it must be confirmed — matching the lead-detail Offers tab.
  describe('send confirmation', () => {
    beforeEach(() => {
      get.mockImplementation((url: string) =>
        url === '/offers'
          ? Promise.resolve({ data: { data: [DRAFT_OFFER], meta: { total: 1, page: 1, limit: 20, totalPages: 1 } } })
          : Promise.resolve(EMPTY),
      );
    });
    afterEach(() => vi.restoreAllMocks());

    it('does NOT send when the confirmation is dismissed', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<OffersPage />, { wrapper });

      await screen.findByText('Acme');
      await userEvent.click(screen.getByRole('button', { name: 'common.actions' }));
      await userEvent.click(await screen.findByText('offers.actions.send'));

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalledWith('/offers/o1/send');
    });

    it('sends when the confirmation is accepted', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<OffersPage />, { wrapper });

      await screen.findByText('Acme');
      await userEvent.click(screen.getByRole('button', { name: 'common.actions' }));
      await userEvent.click(await screen.findByText('offers.actions.send'));

      expect(post).toHaveBeenCalledWith('/offers/o1/send');
    });
  });
});
