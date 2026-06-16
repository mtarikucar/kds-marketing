import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Stub the API — list resolves empty, post returns a minted key with a raw secret.
vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({
      data: {
        id: 'k1',
        name: 'CI key',
        prefix: 'mk_live_abcd1234',
        scopes: ['read', 'write'],
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        key: 'mk_live_RAWSECRETVALUE_shown_once',
      },
    }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ApiKeysPage from './ApiKeysPage';

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('ApiKeysPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<ApiKeysPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('opens the create dialog and validates an empty name', async () => {
    const user = userEvent.setup();
    render(<ApiKeysPage />, { wrapper });

    // Open the create dialog
    const newBtns = screen.getAllByRole('button', { name: /create key/i });
    await user.click(newBtns[0]);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();

    // Clear default name? It's empty by default — submit straight away.
    const submitBtns = screen.getAllByRole('button', { name: /create key/i });
    await user.click(submitBtns[submitBtns.length - 1]);

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  it('submits a valid form and shows the show-once raw key', async () => {
    const { default: marketingApi } = await import(
      '../../../../features/marketing/api/marketingApi'
    );
    const user = userEvent.setup();
    render(<ApiKeysPage />, { wrapper });

    await user.click(screen.getAllByRole('button', { name: /create key/i })[0]);
    await screen.findByRole('heading', { level: 2 });

    await user.type(screen.getByLabelText(/name/i), 'CI key');

    const submitBtns = screen.getAllByRole('button', { name: /create key/i });
    await user.click(submitBtns[submitBtns.length - 1]);

    await waitFor(() => {
      expect(marketingApi.post).toHaveBeenCalledWith(
        '/api-keys',
        expect.objectContaining({ name: 'CI key', scopes: ['read', 'write'] }),
      );
    });

    // The raw secret is surfaced exactly once in a copy dialog.
    expect(await screen.findByText(/mk_live_RAWSECRETVALUE_shown_once/)).toBeInTheDocument();
  });
});
