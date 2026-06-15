/**
 * Smoke tests for the re-skinned app shell:
 *   - MarketingSidebar — Router + i18n + auth store
 *   - MarketingHeader  — Router + QueryClientProvider + i18n
 *
 * These are mount-level checks that the components render their key chrome
 * without crashing. Network queries fire but fail silently (retry: false,
 * no server in test). No mocks required for the happy path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

// Bootstrap i18n so t() resolves instead of returning the key.
import '@/i18n/config';

import { useMarketingAuthStore } from '@/store/marketingAuthStore';
import type { MarketingUser } from '@/store/marketingAuthStore';
import MarketingSidebar from './MarketingSidebar';
import MarketingHeader from './MarketingHeader';

// ---------------------------------------------------------------------------
// Shared test user
// ---------------------------------------------------------------------------
const ADA: MarketingUser = {
  id: 'u-1',
  workspaceId: 'ws-1',
  email: 'ada@x.io',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: 'MANAGER',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset auth store to a logged-in MANAGER before each test. */
function loginAs(user: MarketingUser = ADA) {
  useMarketingAuthStore.setState({
    user,
    accessToken: 'tok',
    refreshToken: 'rtok',
    isAuthenticated: true,
  });
}

/** Build a quiet QueryClient suitable for smoke tests (no retries = no noise). */
function makeQC() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function SidebarWrapper({ qc }: { qc: QueryClient }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <MarketingSidebar />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function HeaderWrapper({ qc }: { qc: QueryClient }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <MarketingHeader />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Sidebar smoke tests
// ---------------------------------------------------------------------------
describe('MarketingSidebar', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQC();
    loginAs();
  });

  afterEach(() => {
    useMarketingAuthStore.setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
    });
    qc.clear();
  });

  it('mounts without crashing', () => {
    render(<SidebarWrapper qc={qc} />);
    // The aside element is the root element of the sidebar.
    expect(document.querySelector('aside')).toBeTruthy();
  });

  it('renders the Dashboard nav link', () => {
    render(<SidebarWrapper qc={qc} />);
    // Nav items use the inline `label` as i18n fallback — "Dashboard" is always present.
    const dashboardLink = screen.getByRole('link', { name: /dashboard/i });
    expect(dashboardLink).toBeInTheDocument();
    expect(dashboardLink).toHaveAttribute('href', '/dashboard');
  });

  it('shows the authenticated user\'s initials in the user card', () => {
    render(<SidebarWrapper qc={qc} />);
    // Initials: Ada Lovelace → "AL"
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('renders the navigation landmark', () => {
    render(<SidebarWrapper qc={qc} />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('renders at least one nav link for a MANAGER with core entitlements', () => {
    render(<SidebarWrapper qc={qc} />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Header smoke tests
// ---------------------------------------------------------------------------
describe('MarketingHeader', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQC();
    loginAs();
  });

  afterEach(() => {
    useMarketingAuthStore.setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
    });
    qc.clear();
  });

  it('mounts without crashing', () => {
    render(<HeaderWrapper qc={qc} />);
    expect(document.querySelector('header')).toBeTruthy();
  });

  it('renders the ThemeToggle group', () => {
    render(<HeaderWrapper qc={qc} />);
    expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument();
  });

  it('renders the Notifications icon button', () => {
    render(<HeaderWrapper qc={qc} />);
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('renders the user\'s full name in the profile trigger', () => {
    render(<HeaderWrapper qc={qc} />);
    // The profile dropdown trigger shows "Ada Lovelace" (hidden on mobile, visible on sm+).
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });
});
