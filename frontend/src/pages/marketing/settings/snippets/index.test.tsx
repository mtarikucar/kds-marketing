import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SnippetsPage from './index';

const post = vi.fn().mockResolvedValue({ data: { body: 'Merhaba! Size nasıl yardımcı olabilirim?' } });
vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: (...a: unknown[]) => post(...a),
  },
}));
vi.mock('../../../../features/marketing/api/snippets.service', () => ({
  listSnippets: vi.fn().mockResolvedValue([]),
  createSnippet: vi.fn(),
  updateSnippet: vi.fn(),
  deleteSnippet: vi.fn(),
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }));

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

describe('SnippetsPage — Fill with AI', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes a "Fill with AI" button in the new-snippet dialog', async () => {
    render(<SnippetsPage />, { wrapper });
    await userEvent.click(screen.getAllByRole('button', { name: /new snippet/i })[0]);
    expect(await screen.findByRole('button', { name: /fill with ai/i })).toBeInTheDocument();
  });

  it('requires a title before calling the AI composer', async () => {
    render(<SnippetsPage />, { wrapper });
    await userEvent.click(screen.getAllByRole('button', { name: /new snippet/i })[0]);
    // No title typed → the button must guard, warn, and NOT hit /ai/compose.
    await userEvent.click(await screen.findByRole('button', { name: /fill with ai/i }));
    expect(post).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it('drafts the body from the title via /ai/compose', async () => {
    render(<SnippetsPage />, { wrapper });
    await userEvent.click(screen.getAllByRole('button', { name: /new snippet/i })[0]);
    await userEvent.type(await screen.findByLabelText(/title/i), 'Reply to a pricing question');
    await userEvent.click(screen.getByRole('button', { name: /fill with ai/i }));
    expect(post).toHaveBeenCalledWith('/ai/compose', expect.objectContaining({ kind: 'sms' }));
    // The returned body lands in the Message textarea.
    expect(await screen.findByDisplayValue(/nasıl yardımcı olabilirim/i)).toBeInTheDocument();
  });
});
