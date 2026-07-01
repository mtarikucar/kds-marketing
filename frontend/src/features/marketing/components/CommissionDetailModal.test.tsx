import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CommissionDetailModal from './CommissionDetailModal';
import { formatMoney } from '../../../lib/money';

const get = vi.fn();
vi.mock('../api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

// Manager so the "edit amount" affordance is shown.
vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: () => ({ user: { role: 'MANAGER', id: 'u-1' } }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => (typeof opts === 'string' ? opts : key),
    i18n: { language: 'en' },
  }),
}));

const commission = (id: string, amount: number) => ({
  id,
  amount,
  type: 'SIGNUP',
  status: 'PENDING',
  period: '2026-06',
  createdAt: '2026-06-01T00:00:00Z',
  auditLog: [],
});

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('CommissionDetailModal — amount editor reset', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (url === '/commissions/cA') return Promise.resolve({ data: commission('cA', 100) });
      if (url === '/commissions/cB') return Promise.resolve({ data: commission('cB', 200) });
      return Promise.resolve({ data: {} });
    });
  });

  // Regression: the modal is mounted persistently by the parent, so the inline
  // amount editor (editingAmount/draftAmount) must reset when the opened
  // commission changes — otherwise a draft typed for cA leaks onto cB and a
  // Save could write the wrong amount to the wrong commission.
  it('closes the amount editor when switching to another commission', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CommissionDetailModal commissionId="cA" onClose={() => undefined} />,
      { wrapper },
    );

    await screen.findByText(formatMoney(100, 'TRY'));
    // Open the inline editor for cA and type a new amount.
    await user.click(screen.getByText('Tutarı düzelt'));
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '500');

    // Switch the modal to commission cB.
    rerender(<CommissionDetailModal commissionId="cB" onClose={() => undefined} />);
    await screen.findByText(formatMoney(200, 'TRY'));

    // The editor must be closed (no stale 500 input carried from cA).
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    // And the edit affordance is offered fresh for cB.
    expect(screen.getByText('Tutarı düzelt')).toBeInTheDocument();
  });

  // The modal has no per-row currency, so it must format amounts in the workspace
  // currency (passed by CommissionsPage, which does the same in its list). It used
  // to hardcode ₺, showing a false symbol on a non-TRY workspace.
  it('formats the amount in the workspace currency (not a hardcoded ₺)', async () => {
    render(
      <CommissionDetailModal commissionId="cA" onClose={() => undefined} currency="USD" />,
      { wrapper },
    );
    await screen.findByText(formatMoney(100, 'USD'));
    expect(screen.queryByText('₺100.00')).not.toBeInTheDocument();
  });
});
