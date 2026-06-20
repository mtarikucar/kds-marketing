import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ProductsPage from './ProductsPage';

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
    get.mockResolvedValue({ data: PRODUCTS });
  });

  it('lists products from the catalog', async () => {
    render(<ProductsPage />, { wrapper });
    expect(await screen.findByText('Pro plan')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/products', expect.anything());
  });
});
