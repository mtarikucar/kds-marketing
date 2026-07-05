import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ProductsPage from './ProductsPage';

const get = vi.fn();
const del = vi.fn();
const patch = vi.fn();
const post = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: (...args: unknown[]) => patch(...args),
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

// Stub the embedded (lazy) tab pages so the hub shell renders in isolation;
// echo the `embedded` prop so the tests can assert it is passed.
vi.mock('../settings/taxRates', () => ({
  default: ({ embedded }: { embedded?: boolean }) => <div>tax-rates-stub:{String(!!embedded)}</div>,
}));
vi.mock('../settings/coupons', () => ({
  default: ({ embedded }: { embedded?: boolean }) => <div>coupons-stub:{String(!!embedded)}</div>,
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

/** Mount the page at a concrete URL so `?tab=` deep links can be exercised. */
function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <ProductsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProductsPage', () => {
  beforeEach(() => {
    get.mockReset();
    del.mockReset();
    patch.mockReset();
    post.mockReset();
    del.mockResolvedValue({ data: { message: 'ok' } });
    patch.mockResolvedValue({ data: {} });
    post.mockResolvedValue({ data: {} });
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

  it('renders the three hub tabs with the catalog selected by default', async () => {
    renderAt('/products');
    for (const label of ['Products', 'Tax Rates', 'Coupons']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('tab', { name: 'Products' })).toHaveAttribute('data-state', 'active');
    // The catalog body (not a stub) is what the default tab shows.
    expect(await screen.findByText('Pro plan')).toBeInTheDocument();
  });

  it('honors the ?tab=tax-rates deep link (embedded Tax Rates page mounted)', async () => {
    renderAt('/products?tab=tax-rates');
    expect(screen.getByRole('tab', { name: 'Tax Rates' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('tax-rates-stub:true')).toBeInTheDocument();
    expect(screen.queryByText('coupons-stub:true')).not.toBeInTheDocument();
  });

  it('honors the ?tab=coupons deep link (embedded Coupons page mounted)', async () => {
    renderAt('/products?tab=coupons');
    expect(screen.getByRole('tab', { name: 'Coupons' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('coupons-stub:true')).toBeInTheDocument();
  });

  it('falls back to the catalog tab on an unknown ?tab= value', () => {
    renderAt('/products?tab=bogus');
    expect(screen.getByRole('tab', { name: 'Products' })).toHaveAttribute('data-state', 'active');
  });

  it('switches tabs on click and keeps the New product action reachable on the catalog tab', async () => {
    renderAt('/products');
    expect(await screen.findByRole('button', { name: /new product/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Coupons' }));
    expect(await screen.findByText('coupons-stub:true')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Coupons' })).toHaveAttribute('data-state', 'active');
  });

  it('persists a cleared description/SKU on edit (sends "" not undefined so the blank sticks)', async () => {
    // A PATCH that omits a field leaves it unchanged in the backend's Prisma
    // merge, so coercing a cleared field to undefined meant "remove the SKU"
    // silently kept the old value. Editing to blank must send '' to clear.
    get.mockResolvedValue({
      data: {
        ...PRODUCTS,
        data: [{ ...PRODUCTS.data[0], description: 'Old description', sku: 'OLD-SKU' }],
      },
    });
    render(<ProductsPage />, { wrapper });
    await screen.findByText('Pro plan');

    await userEvent.click(screen.getByRole('button', { name: /edit product/i }));
    await userEvent.clear(await screen.findByDisplayValue('Old description'));
    await userEvent.clear(screen.getByDisplayValue('OLD-SKU'));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/products/p1',
        expect.objectContaining({ description: '', sku: '' }),
      ),
    );
  });
});
