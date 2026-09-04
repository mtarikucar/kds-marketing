import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import MarketingLayout from './MarketingLayout';

// The app chrome around the pane under test is stubbed — this is a test of ONE
// decision (which shell wraps the routed page), and the sidebar/header/webphone
// have their own. SettingsLayout is deliberately NOT stubbed: whether it
// renders is the assertion.
vi.mock('./MarketingSidebar', () => ({ default: () => <div /> }));
vi.mock('./MarketingHeader', () => ({ default: () => <div /> }));
vi.mock('./HubSubNav', () => ({ default: () => <div /> }));
vi.mock('./AskAiPanel', () => ({ default: () => <div /> }));
vi.mock('./CommandPalette', () => ({ default: () => <div /> }));
vi.mock('./ProductTour', () => ({ default: () => <div /> }));
vi.mock('./AgencyImpersonationBanner', () => ({ AgencyImpersonationBanner: () => <div /> }));
vi.mock('../webphone/WebphoneHost', () => ({ default: () => <div /> }));
vi.mock('../hooks/usePageViewTracking', () => ({ usePageViewTracking: vi.fn() }));

const OWNER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'o@x.io', firstName: 'O', lastName: 'X', role: 'OWNER',
};

/** SettingsLayout's own chrome — the secondary sidebar's escape hatch. */
const SETTINGS_CHROME = /Back to app/i;

function renderAt(path: string) {
  useMarketingAuthStore.setState({
    user: OWNER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MarketingLayout />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('MarketingLayout — which shell wraps the page', () => {
  beforeEach(() => useMarketingAuthStore.setState({ user: null }));

  it('wraps an ordinary settings page in the settings area', () => {
    // The control. Without it, a MarketingLayout that never rendered
    // SettingsLayout at all would pass every assertion below.
    renderAt('/invoices');
    expect(screen.getByText(SETTINGS_CHROME)).toBeInTheDocument();
  });

  it('leaves the workflow BUILDER out of the settings area (fullBleed)', () => {
    // The builder is a h-[calc(100vh-7rem)] canvas; the settings pane is a
    // heightless scroll column beside a 240px sidebar, so it would render
    // letterboxed. FULL_BLEED_PREFIXES is the opt-out.
    //
    // Keyed on the PATH since 2026-09-04. The flag used to ride on the
    // `/automations` nav item, and vanished the day the workflow list stopped
    // being a nav item — the builder started rendering letterboxed with nothing
    // reporting a fault. Any page leaving the menu would have lost it the same
    // way, which is why the opt-out no longer depends on being listed.
    renderAt('/automations/abc-123/edit');
    expect(screen.queryByText(SETTINGS_CHROME)).not.toBeInTheDocument();
  });

  it('opts the whole item out, list page included, so the two never split', () => {
    // Deliberate: /automations and its builder are one destination. Chrome that
    // flips halfway through a task is worse than either choice consistently.
    renderAt('/automations');
    expect(screen.queryByText(SETTINGS_CHROME)).not.toBeInTheDocument();
    renderAt('/automations/new');
    expect(screen.queryByText(SETTINGS_CHROME)).not.toBeInTheDocument();
  });
});
