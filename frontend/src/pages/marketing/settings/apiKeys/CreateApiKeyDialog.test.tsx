import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateApiKeyDialog } from './CreateApiKeyDialog';

/**
 * Gap 1 (mcp-write-surface-activation Task 5) — the dialog used to hardcode
 * `read`/`write` as the only selectable scopes, so a granular scope like
 * `settings.manage` (required by jeeta.reallocate_budget) was mintable only
 * by hand-crafting the POST /api-keys body. This pins that the live
 * permission catalog (GET /roles/catalog) is now rendered as selectable
 * checkboxes here too, and that toggling one changes the submitted payload.
 */

const CATALOG = ['leads.read', 'campaigns.write', 'settings.manage'];

vi.mock('@/features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/roles/catalog') return Promise.resolve({ data: CATALOG });
      return Promise.resolve({ data: [] });
    }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('CreateApiKeyDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to legacy read+write only', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <CreateApiKeyDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} isPending={false} />,
      { wrapper },
    );

    await user.type(screen.getByLabelText(/name/i), 'k1');
    await user.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].scopes).toEqual(['read', 'write']);
  });

  it('renders the live granular permission catalog as selectable checkboxes', async () => {
    render(
      <CreateApiKeyDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} isPending={false} />,
      { wrapper },
    );

    expect(await screen.findByRole('checkbox', { name: 'Manage settings' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Draft campaigns' })).toBeInTheDocument();
    expect(screen.getByText('settings.manage')).toBeInTheDocument();
    expect(screen.getByText('campaigns.write')).toBeInTheDocument();
  });

  it('lets an operator mint a key with settings.manage without curl (checking it adds it to the submitted scopes)', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <CreateApiKeyDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} isPending={false} />,
      { wrapper },
    );

    await user.type(screen.getByLabelText(/name/i), 'budget-bot');
    const settingsCheckbox = await screen.findByRole('checkbox', { name: 'Manage settings' });
    await user.click(settingsCheckbox);
    await user.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const scopes: string[] = onSubmit.mock.calls[0][0].scopes;
    expect(scopes).toContain('settings.manage');
    expect(scopes).toContain('read');
    expect(scopes).toContain('write');
  });

  it('lets an operator mint a campaigns.write-only key (draft without publish authority)', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <CreateApiKeyDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} isPending={false} />,
      { wrapper },
    );

    await user.type(screen.getByLabelText(/name/i), 'draft-bot');
    // Uncheck the legacy read/write defaults, keep only the granular scope.
    await user.click(screen.getByRole('checkbox', { name: 'Read' }));
    await user.click(screen.getByRole('checkbox', { name: 'Write' }));
    const draftCheckbox = await screen.findByRole('checkbox', { name: 'Draft campaigns' });
    await user.click(draftCheckbox);
    await user.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const scopes: string[] = onSubmit.mock.calls[0][0].scopes;
    expect(scopes).toEqual(['campaigns.write']);
  });
});
