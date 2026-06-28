import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CustomDomainsPage from './CustomDomainsPage';

const get = vi.fn();
const post = vi.fn();

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: vi.fn(),
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: { defaultValue?: string } | string) =>
      (typeof d === 'string' ? d : d?.defaultValue) ?? _k,
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('CustomDomainsPage — per-row verify loading', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({
      data: [
        { id: 'd1', hostname: 'a.example.com', status: 'PENDING', homeSlug: 'home', lastError: null, instructions: [] },
        { id: 'd2', hostname: 'b.example.com', status: 'PENDING', homeSlug: 'home', lastError: null, instructions: [] },
      ],
    });
    post.mockImplementation((url: string) =>
      url.includes('/verify') ? new Promise(() => {}) : Promise.resolve({ data: {} }),
    );
  });

  it('only disables the Verify button of the domain being verified, not the others', async () => {
    render(<CustomDomainsPage />, { wrapper });

    const buttons = await screen.findAllByRole('button', { name: /verify/i });
    expect(buttons).toHaveLength(2);

    await userEvent.click(buttons[0]);

    const after = screen.getAllByRole('button', { name: /verify/i });
    expect(after[0]).toBeDisabled();
    expect(after[1]).not.toBeDisabled();
  });
});
