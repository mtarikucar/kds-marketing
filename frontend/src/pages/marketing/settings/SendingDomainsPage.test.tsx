import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SendingDomainsPage from './SendingDomainsPage';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn().mockResolvedValue({ data: {} });

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
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

describe('SendingDomainsPage — per-row verify loading', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    del.mockClear();
    get.mockResolvedValue({
      data: [
        { id: 'd1', domain: 'a.example.com', status: 'PENDING', fromEmail: null, lastError: null, records: [] },
        { id: 'd2', domain: 'b.example.com', status: 'PENDING', fromEmail: null, lastError: null, records: [] },
      ],
    });
    // Verify never resolves → the mutation stays pending so we can observe which
    // row reflects the loading state.
    post.mockImplementation((url: string) =>
      url.includes('/verify') ? new Promise(() => {}) : Promise.resolve({ data: {} }),
    );
  });

  it('only disables the Verify button of the domain being verified, not the others', async () => {
    render(<SendingDomainsPage />, { wrapper });

    const buttons = await screen.findAllByRole('button', { name: /verify/i });
    expect(buttons).toHaveLength(2);

    await userEvent.click(buttons[0]);

    const after = screen.getAllByRole('button', { name: /verify/i });
    expect(after[0]).toBeDisabled(); // the one we clicked is loading
    expect(after[1]).not.toBeDisabled(); // the other domain stays actionable
  });

  // A sending domain is DNS-verified email infrastructure — deleting it stops
  // authenticated email from that domain (DKIM/SPF), and re-adding means redoing
  // the DNS records. The trash button must confirm, not delete on a single click.
  it('confirms before deleting a domain (no immediate delete)', async () => {
    render(<SendingDomainsPage />, { wrapper });

    const delButtons = await screen.findAllByRole('button', { name: 'Delete' });
    expect(delButtons).toHaveLength(2);

    await userEvent.click(delButtons[0]);
    expect(del).not.toHaveBeenCalled();

    const confirm = await screen.findByRole('dialog');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/sending-domains/d1'));
  });
});
