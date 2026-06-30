import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AffiliatesPage from './AffiliatesPage';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('../../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[key.length - 1] : key),
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

describe('AffiliatesPage', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    patch.mockReset();
    del.mockReset();
    get.mockResolvedValue({ data: [] });
    post.mockResolvedValue({ data: { id: '1' } });
    patch.mockResolvedValue({ data: {} });
    del.mockResolvedValue({ data: {} });
  });

  it('mounts and renders the page heading', () => {
    render(<AffiliatesPage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('renders the three tabs', () => {
    render(<AffiliatesPage />, { wrapper });
    expect(screen.getByRole('tab', { name: /referrals/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /commissions/i })).toBeInTheDocument();
  });

  it('opens the create dialog and validates an empty form', async () => {
    render(<AffiliatesPage />, { wrapper });
    const newBtns = screen.getAllByRole('button', { name: /new affiliate/i });
    await userEvent.click(newBtns[0]);
    expect(await screen.findByRole('heading', { level: 2 })).toBeInTheDocument();
    // The dialog submit button is the last "New affiliate" button.
    const allNewBtns = screen.getAllByRole('button', { name: /new affiliate/i });
    await userEvent.click(allNewBtns[allNewBtns.length - 1]);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  // Regression (per-row mutation loading): the per-commission Approve/Mark-paid
  // menu items drove `disabled` off a SHARED mutation's isPending, so acting on
  // one commission disabled that action on every other OWED/APPROVED row's menu
  // until the request finished. The guard must be scoped to the acting row.
  describe('per-commission action loading', () => {
    const AFF = { id: 'aff1', name: 'Acme Partner', email: 'p@x.com', code: 'ACME', commissionType: 'PERCENT', commissionValue: '10', status: 'ACTIVE' };
    const commission = (id: string) => ({ id, affiliateId: 'aff1', amount: '100', status: 'OWED', createdAt: '2026-06-01T00:00:00Z' });

    beforeEach(() => {
      get.mockImplementation((url: string) => {
        if (url === '/affiliates') return Promise.resolve({ data: { data: [AFF] } });
        if (url === '/affiliates/commissions') return Promise.resolve({ data: [commission('m1'), commission('m2')] });
        return Promise.resolve({ data: [] });
      });
      // Approve never resolves → the mutation stays pending after the click.
      patch.mockImplementation(() => new Promise(() => {}));
    });
    afterEach(() => vi.restoreAllMocks());

    it("approving one commission does not disable another commission's Approve action", async () => {
      const user = userEvent.setup();
      render(<AffiliatesPage />, { wrapper });

      // Move to the Commissions tab (the query is enabled only there).
      await user.click(screen.getByRole('tab', { name: 'Commissions' }));

      const triggers = await screen.findAllByRole('button', { name: 'Actions' });
      expect(triggers).toHaveLength(2);

      // Approve the first commission → leaves approveMutation pending.
      await user.click(triggers[0]);
      await user.click(await screen.findByText('Approve'));
      expect(patch).toHaveBeenCalledWith('/affiliates/commissions/m1/approve');

      // Open the SECOND commission's menu while m1's approve is in flight.
      await user.click(screen.getAllByRole('button', { name: 'Actions' })[1]);
      const approve2 = await screen.findByText('Approve');

      // The second commission's Approve must stay actionable — the in-flight
      // guard is scoped to m1, not shared across every OWED row.
      expect(approve2.closest('[role="menuitem"]')).not.toHaveAttribute('data-disabled');
    });
  });
});
