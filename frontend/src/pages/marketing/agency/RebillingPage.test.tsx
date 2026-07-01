import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import RebillingPage from './RebillingPage';
import marketingApi from '../../../features/marketing/api/marketingApi';

const LOCATION = {
  id: 'loc1',
  slug: 'loc-1',
  name: 'Loc One',
  status: 'ACTIVE',
  kind: 'LOCATION',
  parentWorkspaceId: 'ws1',
  productName: 'P',
  productUrl: null,
  defaultCurrency: 'TRY',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const DRAFT_CHARGE = {
  id: 'ch1',
  workspaceId: 'ws1',
  locationWorkspaceId: 'loc1',
  periodStart: '2026-01-01T00:00:00.000Z',
  periodEnd: '2026-02-01T00:00:00.000Z',
  baseAmount: '100.00',
  usageAmount: '20.00',
  totalAmount: '120.00',
  usageUnits: 10,
  status: 'DRAFT',
  stripeChargeId: null,
  createdAt: '2026-02-01T00:00:00.000Z',
};

// The env-gated settle: POST /charge rejects with the backend's
// REBILLING_NOT_CONFIGURED 503; the UI must show a clean banner, never crash.
const NOT_CONFIGURED_ERR = {
  response: { status: 503, data: { message: { code: 'REBILLING_NOT_CONFIGURED', message: 'rebilling not configured (Stripe Connect env unset)' } } },
};

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/auth/profile') {
        return Promise.resolve({ data: { workspace: { id: 'ws1', slug: 'a', name: 'A', kind: 'AGENCY' } } });
      }
      if (url === '/agency/locations') return Promise.resolve({ data: [LOCATION] });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn((url: string) => {
      if (url.endsWith('/compute')) return Promise.resolve({ data: DRAFT_CHARGE });
      if (url.endsWith('/charge')) return Promise.reject(NOT_CONFIGURED_ERR);
      return Promise.resolve({ data: {} });
    }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel?: (s: { isAuthenticated: boolean }) => unknown) => {
    const state = { isAuthenticated: true };
    return sel ? sel(state) : state;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

// Toaster is irrelevant to assertions; stub to keep the DOM clean.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Agency RebillingPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the rebilling heading', async () => {
    render(<RebillingPage />, { wrapper });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  // A RebillCharge carries no currency of its own — it belongs to a location, whose
  // defaultCurrency may be USD/EUR (not the TRY default). The Charges tab total must
  // be formatted in the LOCATION's currency, or a $100 charge renders as "₺100" (a
  // false conversion — the same class the board/forecast guard). The sibling Plans
  // tab + ComputeChargeDialog already pass the location currency.
  it('renders a charge total in the location currency, not a hardcoded ₺', async () => {
    const USD_LOCATION = { ...LOCATION, id: 'loc-usd', name: 'USD Loc', defaultCurrency: 'USD' };
    const USD_CHARGE = { ...DRAFT_CHARGE, id: 'ch-usd', locationWorkspaceId: 'loc-usd', totalAmount: '100.00' };
    (marketingApi.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/auth/profile') {
        return Promise.resolve({ data: { workspace: { id: 'ws1', slug: 'a', name: 'A', kind: 'AGENCY' } } });
      }
      if (url === '/agency/locations') return Promise.resolve({ data: [USD_LOCATION] });
      if (url === '/agency/rebilling/charges') return Promise.resolve({ data: [USD_CHARGE] });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<RebillingPage />, { wrapper });
    await screen.findByRole('heading', { level: 1 });

    await user.click(screen.getByRole('tab', { name: /charges/i }));

    const total = await screen.findByText(/100[.,]00/);
    expect(total.textContent).toMatch(/\$/); // USD symbol, not the TRY default
    expect(total.textContent).not.toMatch(/₺/);
  });

  it('shows the env-gated "rebilling not configured" state instead of crashing', async () => {
    render(<RebillingPage />, { wrapper });
    // Wait for the agency guard + locations to load.
    await screen.findByRole('heading', { level: 1 });

    // Open the row action menu and pick "Compute charge".
    const actionBtn = (await screen.findAllByRole('button', { name: /actions/i }))[0];
    await userEvent.click(actionBtn);
    await userEvent.click(await screen.findByText(/compute charge/i));

    // Fill the period and compute.
    const dialog = await screen.findByRole('dialog');
    const dateInputs = dialog.querySelectorAll('input[type="date"]');
    await userEvent.type(dateInputs[0] as HTMLInputElement, '2026-01-01');
    await userEvent.type(dateInputs[1] as HTMLInputElement, '2026-02-01');
    await userEvent.click(screen.getByRole('button', { name: /^compute$/i }));

    // The computed total renders, then settling surfaces the not-configured banner.
    expect(await screen.findByText(/120/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /charge via stripe connect/i }));

    expect(await screen.findByText(/rebilling not configured/i)).toBeInTheDocument();
  });
});
