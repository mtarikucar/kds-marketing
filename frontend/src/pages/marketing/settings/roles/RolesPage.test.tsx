import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import RolesPage from './RolesPage';

const CATALOG = ['leads.read', 'leads.write', 'users.manage', 'settings.manage'];

vi.mock('@/features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/roles/catalog') return Promise.resolve({ data: CATALOG });
      if (url === '/roles') return Promise.resolve({ data: [] });
      if (url === '/users') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

describe('RolesPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<RolesPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('opens the create dialog and validates an empty role name', async () => {
    render(<RolesPage />, { wrapper });
    const newBtn = screen.getAllByRole('button', { name: /new role/i })[0];
    await userEvent.click(newBtn);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
    // Submit with empty name → a validation error (role=alert) appears.
    const candidates = screen.getAllByRole('button', { name: /new role|save/i });
    const saveBtn = candidates[candidates.length - 1];
    await userEvent.click(saveBtn);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
