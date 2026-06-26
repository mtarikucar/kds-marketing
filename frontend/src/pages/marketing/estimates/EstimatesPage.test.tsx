import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import EstimatesPage from './EstimatesPage';

const get = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
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

const ESTIMATES = [
  {
    id: 'e1',
    leadId: null,
    number: 'EST-ABCD',
    items: [{ description: 'Plan', qty: 1, unitPrice: 9900, taxRateId: 'tr1', taxRatePct: 20 }],
    currency: 'USD',
    // Stored total intentionally left at the pre-tax subtotal so the editor's
    // tax-inclusive total ($118.80) is distinct from the list total ($99.00).
    total: 9900,
    notes: null,
    validUntil: null,
    status: 'SENT',
    convertedInvoiceId: null,
    createdAt: '2026-06-21T00:00:00Z',
  },
];

const TAX_RATES = [{ id: 'tr1', name: 'KDV', rate: 20, isDefault: true, archived: false }];

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('EstimatesPage', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (url === '/estimates') return Promise.resolve({ data: ESTIMATES });
      if (url === '/tax-rates') return Promise.resolve({ data: TAX_RATES });
      return Promise.resolve({ data: {} });
    });
  });

  it('lists estimates with number and formatted total', async () => {
    render(<EstimatesPage />, { wrapper });
    expect(await screen.findByText('EST-ABCD')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/estimates');
  });

  it('shows a tax-inclusive total in the editor when a line carries a tax rate', async () => {
    const user = userEvent.setup();
    render(<EstimatesPage />, { wrapper });
    await screen.findByText('EST-ABCD');
    await user.click(screen.getByTitle('Edit'));
    const dialog = await screen.findByRole('dialog');
    // 99.00 subtotal + 20% KDV = 118.80 — the editor total must reflect tax.
    expect(await within(dialog).findByText(/118[.,]80/)).toBeInTheDocument();
  });
});
