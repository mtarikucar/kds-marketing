import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ReportsPage from './ReportsPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: string) => (typeof o === 'string' ? o : k),
    i18n: { language: 'en' },
  }),
}));

// Stub the heavy embedded tab pages so the shell renders in isolation.
vi.mock('./ads/AdReportingPage', () => ({ default: () => <div>ads-page-stub</div> }));
vi.mock('./PerformancePage', () => ({ default: () => <div>performance-page-stub</div> }));
vi.mock('./analytics/AnalyticsPage', () => ({ default: () => <div>analytics-page-stub</div> }));
vi.mock('./reports/InboundCallStatsPanel', () => ({ default: () => <div>inbound-stats-stub</div> }));

vi.mock('../../features/marketing/api/marketingApi', () => ({
  default: { get: vi.fn(() => Promise.resolve({ data: [] })) },
}));

// Mutable so each test can pick the role (manager vs rep).
const auth = vi.hoisted(() => ({ role: 'MANAGER' }));
vi.mock('../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (selector?: (s: unknown) => unknown) => {
    const state = { user: { role: auth.role }, isAuthenticated: true };
    return selector ? selector(state) : state;
  },
}));

// Mutable so each test can pick whether the workspace is telephony-entitled.
const entitlements = vi.hoisted(() => ({ telephony: false }));
vi.mock('../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    isLoading: false,
    isError: false,
    features: { telephony: entitlements.telephony },
    has: (key?: string) => (key ? !!(entitlements as Record<string, boolean>)[key] : true),
  }),
}));

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <ReportsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ReportsPage', () => {
  beforeEach(() => {
    auth.role = 'MANAGER';
    entitlements.telephony = false;
  });

  it('renders the four unified tabs for a manager', () => {
    renderAt('/reports');
    for (const label of ['Overview', 'Ads', 'Performance', 'Analytics']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('defaults to the Overview tab (its classic lead reports render)', () => {
    renderAt('/reports');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('data-state', 'active');
    // The overview's own nested report tabs are present (label keys via the t mock).
    expect(screen.getByRole('tab', { name: /reports\.tabs\.sources/ })).toBeInTheDocument();
  });

  it('honors the ?tab= deep link (ads selected)', async () => {
    renderAt('/reports?tab=ads');
    expect(screen.getByRole('tab', { name: 'Ads' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('ads-page-stub')).toBeInTheDocument();
  });

  it('honors the ?tab= deep link (performance selected)', async () => {
    renderAt('/reports?tab=performance');
    expect(screen.getByRole('tab', { name: 'Performance' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('performance-page-stub')).toBeInTheDocument();
  });

  it('honors the ?tab= deep link (analytics selected, manager)', async () => {
    renderAt('/reports?tab=analytics');
    expect(screen.getByRole('tab', { name: 'Analytics' })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('analytics-page-stub')).toBeInTheDocument();
  });

  it('falls back to Overview for an unknown ?tab=', () => {
    renderAt('/reports?tab=nope');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('data-state', 'active');
  });

  it('hides the Analytics tab for a non-manager', () => {
    auth.role = 'REP';
    renderAt('/reports');
    expect(screen.queryByRole('tab', { name: 'Analytics' })).not.toBeInTheDocument();
  });

  it('sends a non-manager ?tab=analytics deep link back to Overview', () => {
    auth.role = 'REP';
    renderAt('/reports?tab=analytics');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('data-state', 'active');
    expect(screen.queryByText('analytics-page-stub')).not.toBeInTheDocument();
  });

  it('honors the nested ?sub= deep link inside Overview', () => {
    renderAt('/reports?tab=overview&sub=conversion');
    expect(screen.getByRole('tab', { name: /reports\.tabs\.conversion/ })).toHaveAttribute(
      'data-state',
      'active',
    );
  });

  it('hides the manager-only overview performance sub-tab for a rep', () => {
    auth.role = 'REP';
    renderAt('/reports?tab=overview&sub=performance');
    expect(screen.queryByRole('tab', { name: /reports\.tabs\.performance/ })).not.toBeInTheDocument();
    // Falls back to the sources report.
    expect(screen.getByRole('tab', { name: /reports\.tabs\.sources/ })).toHaveAttribute(
      'data-state',
      'active',
    );
  });

  it('hides the Calls overview sub-tab when the workspace is not telephony-entitled (even for a manager)', () => {
    entitlements.telephony = false;
    renderAt('/reports');
    expect(screen.queryByRole('tab', { name: /reports\.tabs\.calls/ })).not.toBeInTheDocument();
  });

  it('shows the Calls overview sub-tab for a telephony-entitled manager and renders the panel', async () => {
    entitlements.telephony = true;
    renderAt('/reports?tab=overview&sub=calls');
    expect(screen.getByRole('tab', { name: /reports\.tabs\.calls/ })).toHaveAttribute('data-state', 'active');
    expect(await screen.findByText('inbound-stats-stub')).toBeInTheDocument();
  });

  it('hides the Calls sub-tab for a non-manager even when telephony is entitled', () => {
    auth.role = 'REP';
    entitlements.telephony = true;
    renderAt('/reports?tab=overview&sub=calls');
    expect(screen.queryByRole('tab', { name: /reports\.tabs\.calls/ })).not.toBeInTheDocument();
    // Falls back to the sources report.
    expect(screen.getByRole('tab', { name: /reports\.tabs\.sources/ })).toHaveAttribute(
      'data-state',
      'active',
    );
  });
});
