import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import OffersPage from './OffersPage';

// Mock the marketing API
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } } }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
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
    vi.clearAllMocks();
  });

  it('mounts and renders the page header heading', () => {
    render(<OffersPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders a "New offer" button', () => {
    render(<OffersPage />, { wrapper });
    // i18n mock returns the key; accept either the key or the English label
    expect(
      screen.getByRole('button', { name: /new offer|offers\.createButton/i }),
    ).toBeInTheDocument();
  });

  it('opens the create offer dialog when "New offer" is clicked', async () => {
    render(<OffersPage />, { wrapper });
    const newOfferBtn = screen.getByRole('button', { name: /new offer|offers\.createButton/i });
    await userEvent.click(newOfferBtn);
    // Dialog should have a heading at level 2
    const dialogTitle = await screen.findByRole('heading', { level: 2 });
    expect(dialogTitle).toBeInTheDocument();
  });

  it('shows validation error when submitting empty form', async () => {
    render(<OffersPage />, { wrapper });
    const newOfferBtn = screen.getByRole('button', { name: /new offer|offers\.createButton/i });
    await userEvent.click(newOfferBtn);
    // The dialog's submit button (type="submit") — click to trigger RHF validation
    const submitBtns = await screen.findAllByRole('button', { name: /create|save|common\./i });
    // Find the submit (not cancel) button — last one in list
    const submitBtn = submitBtns.find((b) => b.getAttribute('type') === 'submit') ?? submitBtns[submitBtns.length - 1];
    await userEvent.click(submitBtn);
    // Validation alerts should appear (leadId required)
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
