import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    items: [{ description: 'Plan', qty: 1, unitPrice: 9900 }],
    currency: 'USD',
    total: 9900,
    notes: null,
    validUntil: null,
    status: 'SENT',
    convertedInvoiceId: null,
    createdAt: '2026-06-21T00:00:00Z',
  },
];

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
    get.mockImplementation((url: string) =>
      url === '/estimates' ? Promise.resolve({ data: ESTIMATES }) : Promise.resolve({ data: {} }),
    );
  });

  it('lists estimates with number and formatted total', async () => {
    render(<EstimatesPage />, { wrapper });
    expect(await screen.findByText('EST-ABCD')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/estimates');
  });
});
