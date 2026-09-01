import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from 'i18next';
import '@/i18n/config';
import { useMarketingAuthStore, type MarketingUser } from '@/store/marketingAuthStore';
import SettingsLayout from './SettingsLayout';

// Entitlements fail CLOSED while the billing summary is in flight, so without
// this every `feature`-gated settings page — /calls among them — would be
// absent for a reason that has nothing to do with grouping.
vi.mock('../hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    isLoading: false, isError: false, features: {}, entitledModules: [], has: () => true,
  }),
}));

const MANAGER: MarketingUser = {
  id: 'u1', workspaceId: 'w1', email: 'm@x.io', firstName: 'M', lastName: 'X', role: 'MANAGER',
};

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderSettings() {
  useMarketingAuthStore.setState({
    user: MANAGER, accessToken: 't', refreshToken: 'r', isAuthenticated: true,
  });
  return render(
    <MemoryRouter initialEntries={['/branding']}>
      <QueryClientProvider client={makeQC()}>
        <SettingsLayout>
          <div>child</div>
        </SettingsLayout>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('SettingsLayout — sub-grouping', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders the FOUR labelled setting groups instead of one flat list', () => {
    renderSettings();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Data')).toBeInTheDocument();
    expect(screen.getByText('Connections & domains')).toBeInTheDocument();
    expect(screen.getByText('Developer & security')).toBeInTheDocument();
    // No leftover ungrouped bucket: every settings child belongs to a group.
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });

  /**
   * The call log moved here from the Inbox surface (see navigation.test.ts for
   * why). An item in no group falls into the "Other" bucket — which the
   * assertion above holds empty — so arriving in this area is only half the
   * move; it has to be PLACED.
   *
   * It is placed in a group of its own rather than folded into one of the
   * seven that already existed. None of them is honest about it: Workspace is
   * what you configure once, Automation is machinery that runs without you,
   * Products & billing is what you sell, Data is what SHAPES contact records,
   * Connections & domains is external plumbing, Developer & security is
   * tooling, Agency is the sub-account console. A call log is an operational
   * record of work that already happened, and dropping it into any of those
   * would make that group mean "and also calls". A telephony group also gives
   * /voice and /voice/ivr an obvious home the day they follow.
   */
  it('places the call log in a telephony group rather than the Other bucket', () => {
    renderSettings();
    // Inside the group, not merely somewhere on the page: the whole point of
    // the move is WHERE it lands, and the mobile strip renders every item flat.
    const group = screen.getByText('Telephony').parentElement as HTMLElement;
    expect(within(group).getByRole('link', { name: 'Calls' })).toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });

  /**
   * …and on 2026-09-01 they followed. Ses and Telefon Ağacı are channel
   * CONFIGURATION — you record a greeting, wire a menu of options, leave it
   * running — so they belong beside the log rather than on the surface for
   * work that arrives with a person attached.
   *
   * Same trap as the call log: arriving in this area is half the move. An item
   * in no group falls into "Other", which the first test holds empty, so a
   * silent regression would show up as a THIRD assertion failing rather than
   * as these two.
   */
  it('files Ses and Telefon Ağacı in that same telephony group', () => {
    renderSettings();
    const group = screen.getByText('Telephony').parentElement as HTMLElement;
    // The translated labels, not the inline fallbacks: nav.voice is "Voice AI"
    // and nav.ivr is "IVR Menus" ("Sesli AI" / "Sesli Menü (IVR)" in Turkish),
    // which is what a user actually reads in this list.
    expect(within(group).getByRole('link', { name: 'Voice AI' })).toBeInTheDocument();
    expect(within(group).getByRole('link', { name: 'IVR Menus' })).toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });
});
