import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ProductsPage from './ProductsPage';

const get = vi.fn();
const del = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: (...args: unknown[]) => del(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
    i18n: { language: 'en' },
  }),
}));

const PRODUCTS = {
  data: [
    {
      id: 'p1',
      name: 'Pro plan',
      description: null,
      sku: null,
      price: 99,
      currency: 'USD',
      billingType: 'RECURRING',
      interval: 'MONTH',
      taxRate: null,
      active: true,
    },
  ],
  meta: { total: 1, page: 1, limit: 100, totalPages: 1 },
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ProductsPage', () => {
  beforeEach(() => {
    get.mockReset();
    del.mockReset();
    del.mockResolvedValue({ data: { message: 'ok' } });
    get.mockResolvedValue({ data: PRODUCTS });
  });

  it('lists products from the catalog', async () => {
    render(<ProductsPage />, { wrapper });
    expect(await screen.findByText('Pro plan')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/products', expect.anything());
  });

  it('confirms before deleting a product (no immediate delete on the trash click)', async () => {
    render(<ProductsPage />, { wrapper });
    await screen.findByText('Pro plan');

    // Delete can cascade-break a referencing order form (the API 409s), so it
    // must be gated by a confirmation dialog rather than firing on one click.
    await userEvent.click(screen.getByRole('button', { name: /delete product/i }));
    expect(del).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/products/p1'));
  });
});
