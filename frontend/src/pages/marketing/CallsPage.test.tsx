import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CallsPage from './CallsPage';

const getMock = vi.fn();
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => getMock(...args),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({ user: { workspaceId: 'ws-1', role: 'OWNER', id: 'u-1' } }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CallsPage repro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockImplementation((url: string) => {
      if (url === '/calls')
        return Promise.resolve({ data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } } });
      if (url === '/users') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
  });

  it('mounts without crashing (empty)', async () => {
    render(<CallsPage />, { wrapper });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders a populated call row without crashing', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/calls')
        return Promise.resolve({
          data: {
            data: [
              {
                id: 'c1',
                toPhone: '+905551112233',
                status: 'CONNECTED',
                durationSec: 95,
                marketingUserId: 'u-1',
                startedAt: new Date('2026-06-21T10:00:00Z').toISOString(),
                notes: 'hello',
              },
            ],
            meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
          },
        });
      if (url === '/users')
        return Promise.resolve({ data: [{ id: 'u-1', firstName: 'A', lastName: 'B', role: 'REP' }] });
      return Promise.resolve({ data: {} });
    });
    render(<CallsPage />, { wrapper });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
