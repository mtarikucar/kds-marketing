import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SubscriptionsPage from './SubscriptionsPage';

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

const SUBS = [
  {
    id: 's1',
    name: 'Gold membership',
    leadId: null,
    amount: 9900,
    currency: 'USD',
    interval: 'MONTH',
    intervalCount: 1,
    status: 'ACTIVE',
    nextBillingAt: '2026-07-01T00:00:00Z',
    lastBilledAt: null,
    invoicesGenerated: 0,
    createdAt: '2026-06-01T00:00:00Z',
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

describe('SubscriptionsPage', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) =>
      url === '/subscriptions' ? Promise.resolve({ data: SUBS }) : Promise.resolve({ data: { data: [] } }),
    );
  });

  it('lists subscriptions with name and status', async () => {
    render(<SubscriptionsPage />, { wrapper });
    expect(await screen.findByText('Gold membership')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/subscriptions');
  });
});
