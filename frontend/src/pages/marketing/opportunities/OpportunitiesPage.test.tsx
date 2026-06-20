import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import OpportunitiesPage from './OpportunitiesPage';

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

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { id: 'mgr-1', role: 'MANAGER' } }),
}));

const PIPELINES = [
  {
    id: 'p1',
    name: 'Sales Pipeline',
    isDefault: true,
    position: 0,
    archived: false,
    stages: [],
  },
];

const BOARD = {
  pipeline: { id: 'p1', name: 'Sales Pipeline', isDefault: true },
  stages: [
    {
      id: 's-new',
      pipelineId: 'p1',
      name: 'New',
      position: 0,
      probability: 10,
      isWon: false,
      isLost: false,
      opportunities: [
        {
          id: 'o1',
          pipelineId: 'p1',
          stageId: 's-new',
          name: 'Acme deal',
          value: 1000,
          currency: 'USD',
          status: 'OPEN',
        },
      ],
      totalValue: 1000,
      count: 1,
    },
  ],
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('OpportunitiesPage', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (url === '/pipelines') return Promise.resolve({ data: PIPELINES });
      if (url === '/opportunities/board') return Promise.resolve({ data: BOARD });
      return Promise.resolve({ data: {} });
    });
  });

  it('renders the board with the stage column and its deal card', async () => {
    render(<OpportunitiesPage />, { wrapper });

    expect(await screen.findByText('Opportunities')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('New')).toBeInTheDocument());
    expect(screen.getByText('Acme deal')).toBeInTheDocument();
    // The board fetched the default pipeline's board.
    expect(get).toHaveBeenCalledWith('/opportunities/board', expect.anything());
  });
});
