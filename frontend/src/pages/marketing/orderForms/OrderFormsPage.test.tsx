import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import OrderFormsPage, { formFromOrderForm } from './OrderFormsPage';
import type { OrderFormDetail } from '../../../features/marketing/api/order-forms.service';

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

// The list selects a summary that omits collectPhone/phoneRequired/notes.
const LIST_ROW = { id: 'of1', name: 'Pro signup', productId: 'p1', currency: 'TRY', active: true, publicToken: 'of_tok', createdAt: '2026-06-21T00:00:00Z' };
// The saved form REQUIRES a phone (the non-default setting the bug used to lose).
const DETAIL = { ...LIST_ROW, collectPhone: true, phoneRequired: true, notes: null };
const PRODUCTS = { data: [{ id: 'p1', name: 'Pro plan', price: 99, currency: 'TRY', active: true }], meta: { total: 1, page: 1, limit: 100, totalPages: 1 } };

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('OrderFormsPage', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (url === '/order-forms') return Promise.resolve({ data: [LIST_ROW] });
      if (url === '/order-forms/of1') return Promise.resolve({ data: DETAIL });
      return Promise.resolve({ data: PRODUCTS });
    });
  });

  it('lists order forms with name and the linked product', async () => {
    render(<OrderFormsPage />, { wrapper });
    expect(await screen.findByText('Pro signup')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/order-forms');
  });

  // Regression: the list omits phone settings, so opening edit must fetch the
  // full record. Otherwise the editor opened with the defaults and saving reset
  // a "phone required" form back to optional.
  it('loads the saved phone settings on edit (does not reset to defaults)', async () => {
    const user = userEvent.setup();
    render(<OrderFormsPage />, { wrapper });
    await screen.findByText('Pro signup');

    await user.click(screen.getByTitle('Edit'));

    await waitFor(() => expect(get).toHaveBeenCalledWith('/order-forms/of1'));
    const dialog = await screen.findByRole('dialog');
    // The "Phone required" switch must be ON, reflecting the saved value (the
    // Switch has no accessible name, so find it via its labelled row).
    const requiredRow = (await within(dialog).findByText('Phone required')).closest('div')!;
    expect(within(requiredRow).getByRole('switch')).toBeChecked();
  });
});

describe('formFromOrderForm', () => {
  const detail = (over: Partial<OrderFormDetail> = {}): OrderFormDetail =>
    ({ ...DETAIL, ...over }) as OrderFormDetail;

  it('carries the saved collectPhone/phoneRequired through, not the defaults', () => {
    const form = formFromOrderForm(detail({ collectPhone: false, phoneRequired: false }));
    expect(form.collectPhone).toBe(false);
    expect(form.id).toBe('of1');
    expect(form.productId).toBe('p1');
  });

  it('keeps phoneRequired true when the form requires a phone', () => {
    const form = formFromOrderForm(detail({ collectPhone: true, phoneRequired: true }));
    expect(form.phoneRequired).toBe(true);
  });
});
