import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SnapshotsPage from './SnapshotsPage';

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/auth/profile') {
        return Promise.resolve({ data: { workspace: { id: 'ws1', slug: 'a', name: 'A', kind: 'AGENCY' } } });
      }
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn().mockResolvedValue({ data: { id: 's1' } }),
  },
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel?: (s: { isAuthenticated: boolean; user: { role: string } }) => unknown) => {
    const state = { isAuthenticated: true, user: { role: 'OWNER' } };
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

describe('Agency SnapshotsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the snapshots heading', async () => {
    render(<SnapshotsPage />, { wrapper });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('opens the capture dialog and validates the required name', async () => {
    render(<SnapshotsPage />, { wrapper });
    const newBtn = (await screen.findAllByRole('button', { name: /capture snapshot/i }))[0];
    await userEvent.click(newBtn);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
    const candidates = screen.getAllByRole('button', { name: /^capture$/i });
    await userEvent.click(candidates[candidates.length - 1]);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
