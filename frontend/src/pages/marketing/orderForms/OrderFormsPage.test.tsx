import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import OrderFormsPage from './OrderFormsPage';

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

const FORMS = [
  { id: 'of1', name: 'Pro signup', productId: 'p1', currency: 'TRY', active: true, publicToken: 'of_tok', createdAt: '2026-06-21T00:00:00Z' },
];
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
    get.mockImplementation((url: string) =>
      url === '/order-forms' ? Promise.resolve({ data: FORMS }) : Promise.resolve({ data: PRODUCTS }),
    );
  });

  it('lists order forms with name and the linked product', async () => {
    render(<OrderFormsPage />, { wrapper });
    expect(await screen.findByText('Pro signup')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/order-forms');
  });
});
