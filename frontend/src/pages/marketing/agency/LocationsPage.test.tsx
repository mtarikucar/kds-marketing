import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import LocationsPage from './LocationsPage';

// marketingApi: GET /auth/profile returns an AGENCY workspace (so AgencyGuard passes),
// all other GETs return empty lists.
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/auth/profile') {
        return Promise.resolve({ data: { workspace: { id: 'ws1', slug: 'a', name: 'A', kind: 'AGENCY' } } });
      }
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn().mockResolvedValue({ data: { id: 'loc1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

// Authenticated store so useWorkspaceProfile runs its query.
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel?: (s: { isAuthenticated: boolean }) => unknown) => {
    const state = { isAuthenticated: true };
    return sel ? sel(state) : state;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Agency LocationsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the sub-accounts heading once the workspace is an agency', async () => {
    render(<LocationsPage />, { wrapper });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('opens the create dialog and validates required fields', async () => {
    render(<LocationsPage />, { wrapper });
    const newBtn = (await screen.findAllByRole('button', { name: /new sub-account/i }))[0];
    await userEvent.click(newBtn);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
    const candidates = screen.getAllByRole('button', { name: /create sub-account/i });
    const submitBtn = candidates[candidates.length - 1];
    await userEvent.click(submitBtn);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
