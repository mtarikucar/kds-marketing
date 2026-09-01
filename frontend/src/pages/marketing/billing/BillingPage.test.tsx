import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BillingPage from './index';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: unknown) =>
      (typeof d === 'string' ? d : (d as { defaultValue?: string })?.defaultValue) ?? _k,
  }),
}));

const summary = {
  currency: 'TRY',
  providers: ['manual'],
  subscription: { packageCode: 'JEETA', packageName: 'Jeeta', status: 'ACTIVE' },
  entitlements: { maxUsers: 5 },
};

function setRole(role: 'OWNER' | 'MANAGER' | 'REP') {
  useMarketingAuthStore.setState({
    user: { id: 'u1', workspaceId: 'w1', email: 'a@b.c', firstName: 'A', lastName: 'B', role },
  });
}

function renderPage(props: { embedded?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BillingPage {...props} />
    </QueryClientProvider>,
  );
}

/** The row for one add-on: its label, price and Buy button share a container. */
async function addonRow(label: RegExp) {
  return (await screen.findByText(label)).closest('div.rounded-lg') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation((url: string) => {
    if (url === '/billing/summary') return Promise.resolve({ data: summary });
    if (url === '/billing/packages') return Promise.resolve({ data: [] });
    if (url === '/billing/orders')
      return Promise.resolve({
        data: [
          {
            id: 'o1',
            type: 'ADDON',
            providerRef: 'ref-1',
            amount: 4390,
            currency: 'TRY',
            status: 'SUCCEEDED',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
    return Promise.resolve({ data: { used: 0, limit: 10 } });
  });
  post.mockResolvedValue({ data: { handle: { kind: 'bank_transfer', instructions: {} } } });
});

/**
 * The boosts card used to be `isOwner && …`, so the AI-credits summary card
 * above it told a MANAGER to "add more below" while the card holding those
 * buys did not exist. A manager running the day-to-day AI has to be able to
 * see WHICH pack to ask for — and the locked Power-Dialer card now sends
 * non-owners here too, so the card has to be there when they arrive.
 */
describe('BillingPage — boosts are visible to every member, buyable only by the owner', () => {
  it('shows a MANAGER the credit packs, with Buy disabled and labelled Owner only', async () => {
    setRole('MANAGER');
    renderPage();

    const row = (await addonRow(/4\.000 AI credits/));
    const buy = within(row).getByRole('button');
    expect(buy).toBeDisabled();
    expect(buy).toHaveTextContent(/owner only/i);
  });

  it('does not fire a checkout when a MANAGER clicks the disabled Buy', async () => {
    setRole('MANAGER');
    renderPage();

    await screen.findByText(/4\.000 AI credits/);
    await userEvent.click(within((await addonRow(/4\.000 AI credits/))).getByRole('button'));

    expect(post).not.toHaveBeenCalled();
  });

  it('tells a non-owner who can pay', async () => {
    setRole('MANAGER');
    renderPage();
    expect(await screen.findByText(/only the workspace owner can pay/i)).toBeInTheDocument();
  });

  it('lets an OWNER buy a pack', async () => {
    setRole('OWNER');
    renderPage();

    await screen.findByText(/4\.000 AI credits/);
    const buy = within((await addonRow(/4\.000 AI credits/))).getByRole('button');
    expect(buy).toBeEnabled();
    await userEvent.click(buy);

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/billing/checkout', {
        addOnCode: 'credits_4k',
        provider: 'manual',
        billingCycle: 'MONTHLY',
      }),
    );
  });

  /** Prices are now shared; payment history is still genuinely owner-private. */
  it('keeps the payment history owner-only', async () => {
    setRole('MANAGER');
    renderPage();

    await screen.findByText(/4\.000 AI credits/);
    expect(screen.queryByText(/payment history/i)).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith('/billing/orders');
  });
});

describe('BillingPage — add-on notes', () => {
  /**
   * The three NetGSM add-ons were sold as bare labels, so nothing on the buy
   * path said what "Voice campaigns" unlocks — which is the other half of the
   * locked parallel-mode card on the Power Dialer.
   */
  it('says what the voice add-on unlocks, and that NetGSM needs its own package', async () => {
    setRole('OWNER');
    renderPage();

    const note = await screen.findByText(/Power Dialer.s parallel mode/i);
    expect(note).toHaveTextContent(/Otomatik Arama/);
  });

  it('leaves the self-explanatory credit packs without a note', async () => {
    setRole('OWNER');
    renderPage();

    const row = (await addonRow(/4\.000 AI credits/));
    // label + price line only
    expect(within(row).getAllByRole('paragraph')).toHaveLength(2);
  });
});

describe('BillingPage — embedded', () => {
  it('drops its own PageHeader when mounted inside another surface', async () => {
    setRole('OWNER');
    const { rerender } = renderPage();
    expect(await screen.findByText('Billing & Packages')).toBeInTheDocument();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <BillingPage embedded />
      </QueryClientProvider>,
    );
    expect(screen.queryByText('Billing & Packages')).not.toBeInTheDocument();
  });
});
