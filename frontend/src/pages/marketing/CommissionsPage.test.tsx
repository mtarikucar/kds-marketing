import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CommissionsPage from './CommissionsPage';

const get = vi.fn();
const patch = vi.fn();
vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));

vi.mock('../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({ user: { id: 'u1', role: 'MANAGER', workspaceId: 'ws1' } }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

const commission = (id: string, status: string) => ({
  id,
  period: '2026-06',
  type: 'SIGNUP',
  amount: 100,
  status,
  marketingUser: { id: `u-${id}`, firstName: 'Rep', lastName: id },
  createdAt: '2026-06-01T00:00:00Z',
});

const SUMMARY = {
  currency: 'TRY',
  pending: { total: 200, count: 2 },
  approved: { total: 0, count: 0 },
  paid: { total: 0, count: 0 },
};

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('CommissionsPage — per-commission action loading', () => {
  beforeEach(() => {
    get.mockReset();
    patch.mockReset();
    get.mockImplementation((url: string) => {
      if (url === '/commissions') {
        return Promise.resolve({ data: { data: [commission('c1', 'PENDING'), commission('c2', 'PENDING')] } });
      }
      if (url === '/commissions/summary') return Promise.resolve({ data: SUMMARY });
      return Promise.resolve({ data: {} });
    });
    // Approve never resolves → the mutation stays pending after the click.
    patch.mockImplementation(() => new Promise(() => {}));
  });

  it("approving one commission does not disable another commission's Approve button", async () => {
    render(<CommissionsPage />, { wrapper });

    const approveButtons = await screen.findAllByRole('button', { name: /approve/i });
    expect(approveButtons).toHaveLength(2);

    await userEvent.click(approveButtons[0]);
    expect(patch).toHaveBeenCalledWith('/commissions/c1/approve');

    const after = screen.getAllByRole('button', { name: /approve/i });
    // The acting row's button locks; the other commission's Approve must stay
    // actionable (the in-flight guard is scoped to c1, not shared).
    expect(after[0]).toBeDisabled();
    expect(after[1]).not.toBeDisabled();
  });
});
