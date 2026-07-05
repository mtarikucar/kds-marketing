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

// t(key, 'English default') → the default, so tab labels are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: unknown) => (typeof o === 'string' ? o : k), i18n: { language: 'en' } }),
}));

// Stub the lazy-embedded dialer so the host shell renders in isolation.
vi.mock('./DialerPage', () => ({ default: () => <div>dialer-stub</div> }));

function renderAt(path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <CallsPage />
      </MemoryRouter>
    </QueryClientProvider>,
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
    renderAt();
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
    renderAt();
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders the Calls and Power Dialer tabs (calls active by default)', async () => {
    renderAt();
    expect(screen.getByRole('tab', { name: 'Calls' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'Power Dialer' })).toHaveAttribute('data-state', 'inactive');
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('honors the ?tab=dialer deep link (dialer tab selected, dialer body shown)', async () => {
    renderAt('/?tab=dialer');
    expect(screen.getByRole('tab', { name: 'Power Dialer' })).toHaveAttribute('data-state', 'active');
    // Lazy-loaded, so wait for the stubbed dialer body to appear.
    expect(await screen.findByText('dialer-stub')).toBeInTheDocument();
  });

  it('falls back to the calls tab on an unknown ?tab= value', () => {
    renderAt('/?tab=nope');
    expect(screen.getByRole('tab', { name: 'Calls' })).toHaveAttribute('data-state', 'active');
  });
});
