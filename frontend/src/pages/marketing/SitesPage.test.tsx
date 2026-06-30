import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SitesPage from './SitesPage';
import marketingApi from '../../features/marketing/api/marketingApi';

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

  // Each "Start from a template" button is a per-template action. Clicking ONE
  // must only spin/disable THAT button — the shared `fromTemplate` mutation's
  // isPending must be scoped by `variables === tpl.id`, or every template button
  // freezes while one is creating (per-row mutation loading bleed).
  it('only the clicked template button shows loading, not the others', async () => {
    (marketingApi.get as any).mockImplementation((url: string) =>
      url === '/sites/templates'
        ? Promise.resolve({ data: [
            { id: 'tpl-a', name: 'Coffee POS', description: 'a' },
            { id: 'tpl-b', name: 'Salon', description: 'b' },
          ] })
        : Promise.resolve({ data: [] }),
    );
    // Keep the create request in-flight so isPending stays true while we assert.
    (marketingApi.post as any).mockImplementation(() => new Promise(() => {}));

    render(<SitesPage />, { wrapper });

    const first = await screen.findByRole('button', { name: 'Coffee POS' });
    const second = await screen.findByRole('button', { name: 'Salon' });
    await userEvent.click(first);

    await waitFor(() => expect(first).toHaveAttribute('aria-busy', 'true'));
    // The OTHER template button must NOT be caught up in the first one's loading.
    expect(second).not.toHaveAttribute('aria-busy', 'true');
    expect(second).not.toBeDisabled();
  });
});
