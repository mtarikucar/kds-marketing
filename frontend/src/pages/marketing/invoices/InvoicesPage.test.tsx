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

const invoice = (id: string, number: string, currency = 'TRY') => ({
  id,
  number,
  total: 9900,
  currency,
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

  it('requires confirmation before debiting the wallet (a stray click must not move money)', async () => {
    const user = userEvent.setup();
    render(<InvoicesPage />, { wrapper });

    const payBtns = await screen.findAllByTitle('Pay from store credit');
    await user.click(payBtns[0]);

    // The click opens a confirm dialog — an irreversible wallet debit must NOT
    // fire on a single icon click (parity with this file's guarded `void`).
    expect(post).not.toHaveBeenCalledWith('/invoices/i1/pay-with-wallet');
    expect(await screen.findByText('Pay from store credit?')).toBeInTheDocument();

    // Confirming actually settles from the wallet.
    await user.click(screen.getByRole('button', { name: 'Pay now' }));
    expect(post).toHaveBeenCalledWith('/invoices/i1/pay-with-wallet');
  });

  it('requires confirmation before texting the pay link (billable outbound SMS)', async () => {
    const user = userEvent.setup();
    render(<InvoicesPage />, { wrapper });

    const textBtns = await screen.findAllByTitle('Text pay link (SMS)');
    await user.click(textBtns[0]);

    expect(post).not.toHaveBeenCalledWith('/invoices/i1/text-to-pay', { channel: 'SMS' });
    await user.click(await screen.findByRole('button', { name: 'Send SMS' }));
    expect(post).toHaveBeenCalledWith('/invoices/i1/text-to-pay', { channel: 'SMS' });
  });

  it("confirming one invoice's wallet debit does not disable another invoice's pay button", async () => {
    const user = userEvent.setup();
    render(<InvoicesPage />, { wrapper });

    const payBtns = await screen.findAllByTitle('Pay from store credit');
    expect(payBtns).toHaveLength(2);

    await user.click(payBtns[0]);
    await user.click(await screen.findByRole('button', { name: 'Pay now' }));
    expect(post).toHaveBeenCalledWith('/invoices/i1/pay-with-wallet');

    const after = screen.getAllByTitle('Pay from store credit');
    // The acting invoice's pay locks (no double-charge double-click); the other
    // invoice's pay button stays actionable (guard scoped to i1, not shared).
    expect(after[0]).toBeDisabled();
    expect(after[1]).not.toBeDisabled();
  });

  // Store-credit wallets are TRY-only; the backend refuses a cross-currency debit,
  // so a non-TRY invoice must NOT offer "Pay from store credit" (a doomed action).
  it('hides the pay-from-wallet button for a non-TRY invoice', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/invoices') return Promise.resolve({ data: [invoice('i1', 'INV-1', 'TRY'), invoice('i2', 'INV-2', 'USD')] });
      if (url === '/invoices/psp') return Promise.resolve({ data: { provider: 'MANUAL' } });
      return Promise.resolve({ data: {} });
    });
    render(<InvoicesPage />, { wrapper });

    // Both rows load…
    expect(await screen.findByText('INV-2')).toBeInTheDocument();
    // …but only the TRY invoice offers pay-from-wallet.
    expect(screen.getAllByTitle('Pay from store credit')).toHaveLength(1);
  });
});
