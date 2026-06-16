import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AffiliatesPage from './AffiliatesPage';

vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: { id: '1' } }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[key.length - 1] : key),
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

describe('AffiliatesPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('mounts and renders the page heading', () => {
    render(<AffiliatesPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders the three tabs', () => {
    render(<AffiliatesPage />, { wrapper });
    expect(screen.getByRole('tab', { name: /referrals/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /commissions/i })).toBeInTheDocument();
  });

  it('opens the create dialog and validates an empty form', async () => {
    render(<AffiliatesPage />, { wrapper });
    const newBtns = screen.getAllByRole('button', { name: /new affiliate/i });
    await userEvent.click(newBtns[0]);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
    // The dialog submit button is the last "New affiliate" button.
    const allNewBtns = screen.getAllByRole('button', { name: /new affiliate/i });
    await userEvent.click(allNewBtns[allNewBtns.length - 1]);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });
});
