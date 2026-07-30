import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiGet, listPackages, assignPackage } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  listPackages: vi.fn(),
  assignPackage: vi.fn(),
}));

vi.mock('../../features/platform/api/platformApi', () => ({
  default: { get: apiGet, patch: vi.fn() },
  listPackages,
  assignPackage,
}));

vi.mock('../../store/platformAuthStore', () => ({
  usePlatformAuthStore: () => ({ isAuthenticated: true }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, any>) => {
      const template: string = opts?.defaultValue ?? key;
      // Mirror i18next interpolation so the copy assertions test real strings.
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
        opts?.[name] !== undefined ? String(opts[name]) : `{{${name}}}`,
      );
    },
    i18n: { language: 'en' },
  }),
}));

import PlatformWorkspaceDetailPage from './PlatformWorkspaceDetailPage';

const PACKAGES = [
  {
    code: 'GROWTH',
    name: 'Growth',
    description: 'For growing teams.',
    isPublic: true,
    sortOrder: 2,
    trialDays: 0,
    prices: { monthlyTRY: 2400, monthlyUSD: 79, yearlyTRY: null, yearlyUSD: null },
    limits: { dailyLeadQuota: 50, maxUsers: 10 },
  },
  {
    code: 'OPERATOR',
    name: 'Operator (internal)',
    description: 'Unlimited internal package.',
    isPublic: false,
    sortOrder: 9,
    trialDays: 0,
    prices: { monthlyTRY: 0, monthlyUSD: 0, yearlyTRY: null, yearlyUSD: null },
    limits: { dailyLeadQuota: -1, maxUsers: -1 },
  },
];

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ws-1',
    name: 'Acme Inc',
    slug: 'acme',
    kind: 'STANDALONE',
    status: 'ACTIVE',
    productName: 'Acme CRM',
    productUrl: null,
    defaultLanguage: 'en',
    defaultCurrency: 'USD',
    coreIntegration: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    owner: null,
    counts: { users: 3, leads: 12, openLeads: 8, wonLeads: 4 },
    locationCount: 0,
    subscription: {
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      currency: 'USD',
      currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      provider: 'paytr',
      package: { code: 'GROWTH', name: 'Growth', isPublic: true },
    },
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/platform/workspaces/ws-1']}>
        <Routes>
          <Route
            path="/platform/workspaces/:id"
            element={<PlatformWorkspaceDetailPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Pick a package in the Radix select. */
async function pickPackage(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('combobox', { name: 'Package' }));
  await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
  await user.click(screen.getByRole('option', { name }));
}

/** Pick a package and walk the confirm dialog through to the assignment. */
async function assignVia(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await pickPackage(user, name);
  await user.click(screen.getByRole('button', { name: 'Change package' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Assign package' }));
}

describe('PlatformWorkspaceDetailPage — subscription / package section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGet.mockResolvedValue({ data: workspace() });
    listPackages.mockResolvedValue(PACKAGES);
  });

  it('shows the CURRENT package with its status and period end', async () => {
    renderPage();
    expect(await screen.findByText('Subscription / package')).toBeInTheDocument();

    expect(screen.getByText('Growth')).toBeInTheDocument();
    expect(screen.getByText('GROWTH')).toBeInTheDocument();
    // Status badge + the period-end definition row.
    expect(screen.getByText('Period ends')).toBeInTheDocument();
    expect(
      screen.getByText(new Date('2026-09-01T00:00:00.000Z').toLocaleDateString()),
    ).toBeInTheDocument();
  });

  it('names the year-2999 sentinel as "never" instead of printing a bogus date', async () => {
    apiGet.mockResolvedValue({
      data: workspace({
        subscription: {
          status: 'ACTIVE',
          billingCycle: 'MONTHLY',
          currency: 'USD',
          currentPeriodEnd: '2999-12-31T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          trialEndsAt: null,
          provider: 'manual',
          package: { code: 'OPERATOR', name: 'Operator (internal)', isPublic: false },
        },
      }),
    });
    renderPage();
    expect(await screen.findByText('Never (internal grant)')).toBeInTheDocument();
    // …and the internal package is badged as such in the current-state block.
    expect(screen.getByText('Internal')).toBeInTheDocument();
  });

  it('says so plainly when the workspace has never been on a package', async () => {
    apiGet.mockResolvedValue({ data: workspace({ subscription: null }) });
    renderPage();
    expect(
      await screen.findByText(/never been put on a package/i),
    ).toBeInTheDocument();
  });

  it('marks OPERATOR as internal in the picker and warns before the confirm', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Subscription / package');

    await pickPackage(user, /Operator \(internal\) \(OPERATOR\) — internal/);

    expect(
      await screen.findByText('Internal package — not a customer tier'),
    ).toBeInTheDocument();
    expect(screen.getByText(/isPublic: false/)).toBeInTheDocument();
    // Warned, but nothing assigned yet — the confirm step is still ahead.
    expect(assignPackage).not.toHaveBeenCalled();
  });

  it('requires a confirm that names the workspace, the package and the no-invoice caveat', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Subscription / package');

    await pickPackage(user, /Operator \(internal\) \(OPERATOR\) — internal/);
    await user.click(screen.getByRole('button', { name: 'Change package' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Acme Inc/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Operator \(internal\) \(OPERATOR\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/INTERNAL package/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/does not create an invoice and does not create a PSP subscription/),
    ).toBeInTheDocument();
    // Opening the dialog must not itself fire the mutation.
    expect(assignPackage).not.toHaveBeenCalled();
  });

  it('assigns on confirm and shows the returned status + period end', async () => {
    assignPackage.mockResolvedValue({
      workspaceId: 'ws-1',
      packageCode: 'OPERATOR',
      packageName: 'Operator (internal)',
      status: 'ACTIVE',
      changed: true,
      currentPeriodEnd: '2999-12-31T00:00:00.000Z',
      trialEndsAt: null,
      limits: { dailyLeadQuota: -1 },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Subscription / package');

    await assignVia(user, /Operator \(internal\) \(OPERATOR\) — internal/);

    await waitFor(() =>
      expect(assignPackage).toHaveBeenCalledWith('ws-1', 'OPERATOR'),
    );
    expect(await screen.findByText('Package assigned')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Now on Operator (internal) (OPERATOR) — ACTIVE, period ends Never (internal grant).',
      ),
    ).toBeInTheDocument();
  });

  it('refetches so the CURRENT package block shows the new plan without a manual refresh', async () => {
    // Start on GROWTH; the server reports OPERATOR once the grant lands.
    apiGet.mockResolvedValueOnce({ data: workspace() }).mockResolvedValue({
      data: workspace({
        subscription: {
          status: 'ACTIVE',
          billingCycle: 'MONTHLY',
          currency: 'USD',
          currentPeriodEnd: '2999-12-31T00:00:00.000Z',
          cancelAtPeriodEnd: false,
          trialEndsAt: null,
          provider: 'manual',
          package: { code: 'OPERATOR', name: 'Operator (internal)', isPublic: false },
        },
      }),
    });
    assignPackage.mockResolvedValue({
      workspaceId: 'ws-1',
      packageCode: 'OPERATOR',
      packageName: 'Operator (internal)',
      status: 'ACTIVE',
      changed: true,
      currentPeriodEnd: '2999-12-31T00:00:00.000Z',
      trialEndsAt: null,
      limits: { dailyLeadQuota: -1 },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Subscription / package');
    // Before: the current-state block reads GROWTH.
    expect(screen.getByText('GROWTH')).toBeInTheDocument();

    await assignVia(user, /Operator \(internal\) \(OPERATOR\) — internal/);

    // The ['platform','workspace',id] key was invalidated → the detail query
    // refires and the block re-renders off the fresh server state.
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('OPERATOR')).toBeInTheDocument());
    expect(screen.queryByText('GROWTH')).not.toBeInTheDocument();
    expect(screen.getByText('Billed via')).toBeInTheDocument();
    expect(screen.getByText('manual')).toBeInTheDocument();
  });

  it('reports changed:false honestly instead of faking a success', async () => {
    assignPackage.mockResolvedValue({
      workspaceId: 'ws-1',
      packageCode: 'GROWTH',
      packageName: 'Growth',
      status: 'ACTIVE',
      changed: false,
      currentPeriodEnd: '2999-12-31T00:00:00.000Z',
      trialEndsAt: null,
      limits: {},
    });
    const { toast } = await import('sonner');
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Subscription / package');

    await assignVia(user, /^Growth \(GROWTH\)$/);

    expect(await screen.findByText('Nothing changed')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Already on Growth (GROWTH) with exactly this grant — nothing changed.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Package assigned')).not.toBeInTheDocument();
    // No success toast — nothing actually happened.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('renders the backend 400 message verbatim (it lists the valid codes)', async () => {
    const message =
      'Unknown package code "PLATINUM". Valid codes: TRIAL, STARTER, GROWTH, SCALE, OPERATOR';
    assignPackage.mockRejectedValue({ response: { status: 400, data: { message } } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Subscription / package');

    await assignVia(user, /^Growth \(GROWTH\)$/);

    expect(await screen.findByText('Package not assigned')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('renders a 404 as-is rather than swallowing it', async () => {
    assignPackage.mockRejectedValue({
      response: { status: 404, data: { message: 'Workspace not found' } },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Subscription / package');

    await assignVia(user, /^Growth \(GROWTH\)$/);

    expect(await screen.findByText('Workspace not found')).toBeInTheDocument();
  });
});
