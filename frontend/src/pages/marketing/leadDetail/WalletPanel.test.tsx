import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WalletPanel } from './WalletPanel';

const get = vi.fn();
vi.mock('../../../features/marketing/api/wallet.service', () => ({
  getWallet: (leadId: string) => get(leadId),
  creditWallet: vi.fn().mockResolvedValue({}),
  debitWallet: vi.fn().mockResolvedValue({}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _k,
    i18n: { language: 'en' },
  }),
}));

const wallet = (balance: number) => ({ leadId: 'x', balance, currency: 'TRY', ledger: [] });

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('WalletPanel — amount resets per lead', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((leadId: string) =>
      Promise.resolve(wallet(leadId === 'leadA' ? 1000 : 2000)),
    );
  });

  // Regression: the lead-detail route reuses this component across /leads/:id
  // navigations (no remount), so a credit/debit amount typed for one contact
  // must NOT carry onto the next — otherwise money could be moved on the wrong
  // wallet.
  it('clears the typed amount when the leadId prop changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <WalletPanel leadId="leadA" isManager />,
      { wrapper },
    );

    const input = (await screen.findByPlaceholderText('Amount')) as HTMLInputElement;
    await user.type(input, '50');
    expect(input).toHaveValue(50);

    rerender(<WalletPanel leadId="leadB" isManager />);

    await waitFor(() => expect(get).toHaveBeenCalledWith('leadB'));
    // The panel briefly unmounts its body while leadB's wallet loads; wait for
    // the input to reappear, then assert it's empty (no carryover from leadA).
    const input2 = (await screen.findByPlaceholderText('Amount')) as HTMLInputElement;
    expect(input2.value).toBe('');
  });
});
