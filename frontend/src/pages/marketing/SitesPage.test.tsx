import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SitesPage from './SitesPage';

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({ user: { workspaceId: 'ws-1' } }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? key,
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

describe('SitesPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mounts and renders the page heading', () => {
    render(<SitesPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders a "New page" button', () => {
    render(<SitesPage />, { wrapper });
    const btns = screen.getAllByRole('button', { name: /new page|sites\.new/i });
    expect(btns.length).toBeGreaterThan(0);
  });

  it('opens the create page dialog when "New page" is clicked', async () => {
    render(<SitesPage />, { wrapper });
    const btns = screen.getAllByRole('button', { name: /new page|sites\.new/i });
    await userEvent.click(btns[0]);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
  });

  it('shows validation error on empty form submit', async () => {
    render(<SitesPage />, { wrapper });
    const btns = screen.getAllByRole('button', { name: /new page|sites\.new/i });
    await userEvent.click(btns[0]);
    // click Save without filling title
    const saveBtn = await screen.findByRole('button', { name: /^save$|common\.save/i });
    await userEvent.click(saveBtn);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
