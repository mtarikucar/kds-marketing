import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import BookingSettingsPage from './BookingSettingsPage';

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

describe('BookingSettingsPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mounts and renders the page heading', () => {
    render(<BookingSettingsPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders a "New calendar" button', () => {
    render(<BookingSettingsPage />, { wrapper });
    const btns = screen.getAllByRole('button', { name: /new calendar|booking\.new/i });
    expect(btns.length).toBeGreaterThan(0);
  });

  it('opens the create calendar dialog when button is clicked', async () => {
    render(<BookingSettingsPage />, { wrapper });
    const btns = screen.getAllByRole('button', { name: /new calendar|booking\.new/i });
    await userEvent.click(btns[0]);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
  });

  it('shows validation error on empty form submit', async () => {
    render(<BookingSettingsPage />, { wrapper });
    const btns = screen.getAllByRole('button', { name: /new calendar|booking\.new/i });
    await userEvent.click(btns[0]);
    const saveBtn = await screen.findByRole('button', { name: /^save$|common\.save/i });
    await userEvent.click(saveBtn);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
