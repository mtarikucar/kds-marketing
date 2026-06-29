import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InvoicesPage from './index';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

// InvoiceForm is a heavy sub-component irrelevant to the list-action test.
vi.mock('./InvoiceForm', () => ({ InvoiceForm: () => null }));

const invoice = (id: string, number: string) => ({
  id,
  number,
  total: 9900,
  currency: 'USD',
  status: 'SENT',
  createdAt: '2026-06-21T00:00:00Z',
});

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('InvoicesPage — per-invoice action guards', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockImplementation((url: string) => {
      if (url === '/invoices') return Promise.resolve({ data: [invoice('i1', 'INV-1'), invoice('i2', 'INV-2')] });
      if (url === '/invoices/psp') return Promise.resolve({ data: { provider: 'MANUAL' } });
      return Promise.resolve({ data: {} });
    });
    // Pay-from-wallet never resolves → the mutation stays pending after the click.
    post.mockImplementation(() => new Promise(() => {}));
  });

  it("paying one invoice from wallet does not disable another invoice's pay button", async () => {
    const user = userEvent.setup();
    render(<InvoicesPage />, { wrapper });

    const payBtns = await screen.findAllByTitle('Pay from store credit');
    expect(payBtns).toHaveLength(2);

    await user.click(payBtns[0]);
    expect(post).toHaveBeenCalledWith('/invoices/i1/pay-with-wallet');

    const after = screen.getAllByTitle('Pay from store credit');
    // The acting invoice's pay locks (no double-charge double-click); the other
    // invoice's pay button stays actionable (guard scoped to i1, not shared).
    expect(after[0]).toBeDisabled();
    expect(after[1]).not.toBeDisabled();
  });
});
