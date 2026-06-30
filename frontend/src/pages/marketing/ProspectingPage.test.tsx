import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProspectingPage from './ProspectingPage';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));
vi.mock('../../lib/env', () => ({ API_URL: 'http://test/api' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: { defaultValue?: string }) => d?.defaultValue ?? _k,
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const audit = (id: string, score: number) => ({
  id,
  targetUrl: `${id}.com`,
  businessName: id.toUpperCase(),
  status: 'DONE',
  score,
  publicToken: `tok-${id}`,
  convertedLeadId: null,
  createdAt: '',
  completedAt: '',
});

describe('ProspectingPage — per-audit convert loading', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ data: [audit('a1', 80), audit('a2', 70)] });
    // Convert never resolves → the mutation stays pending after the click.
    post.mockImplementation(() => new Promise(() => {}));
  });

  it('converting one audit only disables that audit\'s To-lead button', async () => {
    render(<ProspectingPage />, { wrapper });
    const buttons = await screen.findAllByRole('button', { name: /to lead/i });
    expect(buttons).toHaveLength(2);

    await userEvent.click(buttons[0]);

    const after = screen.getAllByRole('button', { name: /to lead/i });
    expect(after[0]).toBeDisabled();
    expect(after[1]).not.toBeDisabled();
  });
});
