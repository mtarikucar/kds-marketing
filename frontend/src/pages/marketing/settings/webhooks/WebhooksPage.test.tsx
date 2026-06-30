import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Stub the API — list resolves empty, post returns an endpoint with a whsec_ secret.
vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({
      data: {
        id: 'wh1',
        url: 'https://example.com/hook',
        events: [],
        status: 'ACTIVE',
        secret: 'whsec_RAWSIGNINGSECRET_shown_once',
      },
    }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
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

import WebhooksPage from './WebhooksPage';

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('WebhooksPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<WebhooksPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('opens the add dialog and validates an invalid URL', async () => {
    const user = userEvent.setup();
    render(<WebhooksPage />, { wrapper });

    await user.click(screen.getAllByRole('button', { name: /add endpoint/i })[0]);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();

    // Type a non-URL value, then submit → zod url() error (role=alert).
    await user.type(screen.getByLabelText(/endpoint url/i), 'not-a-url');
    const submitBtns = screen.getAllByRole('button', { name: /add endpoint/i });
    await user.click(submitBtns[submitBtns.length - 1]);

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  it('submits a valid endpoint and reveals the whsec_ secret once', async () => {
    const { default: marketingApi } = await import(
      '../../../../features/marketing/api/marketingApi'
    );
    const user = userEvent.setup();
    render(<WebhooksPage />, { wrapper });

    await user.click(screen.getAllByRole('button', { name: /add endpoint/i })[0]);
    await screen.findByRole('heading', { level: 2 });

    await user.type(screen.getByLabelText(/endpoint url/i), 'https://example.com/hook');

    const submitBtns = screen.getAllByRole('button', { name: /add endpoint/i });
    await user.click(submitBtns[submitBtns.length - 1]);

    await waitFor(() => {
      expect(marketingApi.post).toHaveBeenCalledWith(
        '/webhooks',
        expect.objectContaining({ url: 'https://example.com/hook' }),
      );
    });

    expect(
      await screen.findByText(/whsec_RAWSIGNINGSECRET_shown_once/),
    ).toBeInTheDocument();
  });
});

// Regression: each endpoint row's Send-test button and Enable switch were driven
// off a single shared mutation's isPending, so acting on ONE endpoint disabled
// that control on EVERY endpoint (the Button maps loading/pending → disabled).
// The per-row guard (mutation.variables === ep.id) must scope it to one row.
describe('WebhooksPage — per-row mutation loading (no cross-row bleed)', () => {
  const endpoints = [
    { id: 'ep1', url: 'https://a.example.com/hook', status: 'ACTIVE', failureCount: 0, description: null, events: [], lastDeliveryAt: null },
    { id: 'ep2', url: 'https://b.example.com/hook', status: 'ACTIVE', failureCount: 0, description: null, events: [], lastDeliveryAt: null },
  ];

  beforeEach(async () => {
    const { default: api } = await import('../../../../features/marketing/api/marketingApi');
    (api.get as any).mockResolvedValue({ data: endpoints });
    // Never-resolving → the mutation stays pending so we can read the row state.
    (api.post as any).mockImplementation(() => new Promise(() => {}));
    (api.patch as any).mockImplementation(() => new Promise(() => {}));
  });

  it('sending a test only disables that endpoint\'s Send-test button', async () => {
    render(<WebhooksPage />, { wrapper });

    const testButtons = await screen.findAllByRole('button', { name: /send test/i });
    expect(testButtons).toHaveLength(2);

    await userEvent.click(testButtons[0]);

    const after = screen.getAllByRole('button', { name: /send test/i });
    expect(after[0]).toBeDisabled();
    expect(after[1]).not.toBeDisabled();
  });

  it('toggling one endpoint only disables that endpoint\'s switch', async () => {
    render(<WebhooksPage />, { wrapper });

    const switches = await screen.findAllByRole('switch');
    expect(switches).toHaveLength(2);

    await userEvent.click(switches[0]);

    const after = screen.getAllByRole('switch');
    expect(after[0]).toBeDisabled();
    expect(after[1]).not.toBeDisabled();
  });
});
