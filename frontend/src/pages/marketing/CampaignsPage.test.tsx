import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CampaignsPage from './CampaignsPage';

const get = vi.fn();
const post = vi.fn().mockResolvedValue({ data: { recipients: 5 } });
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
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

const DRAFT = [{ id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'DRAFT', stats: null }];

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CampaignsPage launch', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockClear();
    get.mockImplementation((url: string) =>
      url === '/campaigns' ? Promise.resolve({ data: DRAFT }) : Promise.resolve({ data: [] }),
    );
  });

  it('confirms before launching — a single click does NOT mass-send', async () => {
    const user = userEvent.setup();
    render(<CampaignsPage />, { wrapper });

    // The row's Launch button (only one before the confirm dialog opens).
    const rowLaunch = await screen.findByRole('button', { name: /Launch/i });
    await user.click(rowLaunch);

    // No send yet — the confirm dialog is shown instead of firing the mutation.
    expect(post).not.toHaveBeenCalled();

    // Confirm in the dialog actually launches.
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Launch/i }));
    expect(post).toHaveBeenCalledWith('/campaigns/c1/launch');
  });
});
