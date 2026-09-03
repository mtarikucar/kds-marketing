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

  it('renders labelled setting groups instead of one flat list', () => {
    renderSettings();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Data')).toBeInTheDocument();
    // Seven groups since 2026-09-03, down from nine. "Marketing assets" folded
    // into "Marketing" and the standalone "Telephony" into "Channels &
    // domains": a workflow running unattended and an email template waiting to
    // be used is a true difference, and not one anybody navigates by.
    expect(screen.getByText('Marketing')).toBeInTheDocument();
    expect(screen.getByText('Channels & domains')).toBeInTheDocument();
    expect(screen.getByText('Developer & security')).toBeInTheDocument();
    expect(screen.queryByText('Marketing assets')).not.toBeInTheDocument();
    expect(screen.queryByText('Telephony')).not.toBeInTheDocument();
    // No leftover ungrouped bucket: every settings child belongs to a group.
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });

  /**
   * The same sidebar, in the product's first language.
   *
   * Every group heading here resolves through `t('settingsGroup.<key>', label)`
   * with an ENGLISH inline default, which is fine for the nine groups that have
   * a catalogue entry and invisible for the one that did not: "Marketing
   * assets" — the group Growth Studio's three homeless pages moved into — was
   * in neither `tr` nor `en`, so a Turkish operator read one English heading in
   * an otherwise Turkish list. The English test above could never catch it,
   * because the missing key falls back to exactly the string it asserts.
   *
   * The Back-to-app link is in the same assertion for the same reason: it was
   * `t('settings.backToApp', { defaultValue: 'Back to app' })` against no
   * catalogue entry at all, i.e. the top line of this sidebar was English in
   * every language the product ships.
   */
  it('renders the group headings in Turkish, including the newest one', async () => {
    await i18n.changeLanguage('tr');
    try {
      renderSettings();
      expect(screen.getByText('Pazarlama')).toBeInTheDocument();
      expect(screen.getByText('Uygulamaya dön')).toBeInTheDocument();
      // Its neighbours, to prove the assertion is about a Turkish list rather
      // than about one string that happens to be translated. The two renamed
      // groups are here on purpose: a heading that lost its catalogue entry in
      // the merge would read as English in an otherwise Turkish list, which is
      // exactly the defect this test was written for.
      expect(screen.getByText('Çalışma Alanı')).toBeInTheDocument();
      expect(screen.getByText('Kanallar ve alan adları')).toBeInTheDocument();
      expect(screen.getByText('Veri')).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
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
    const group = screen.getByText('Channels & domains').parentElement as HTMLElement;
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
  it('files Ses in that same channels group — as ONE entry, not two', () => {
    renderSettings();
    const group = screen.getByText('Channels & domains').parentElement as HTMLElement;
    // The translated label, not the inline fallback: nav.voice is "Voice AI"
    // ("Sesli AI" in Turkish), which is what a user actually reads here.
    expect(within(group).getByRole('link', { name: 'Voice AI' })).toBeInTheDocument();
    // The phone tree is a TAB of that page now, so it must not also be a line
    // in this list — two entries onto one page is the shape being removed.
    expect(screen.queryByRole('link', { name: 'IVR Menus' })).not.toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });

  /**
   * The six pairs, from the reader's side: each absorbed page must be GONE from
   * the list. navigation.test.ts proves their paths still resolve; this proves
   * the list actually got shorter, which is the half a user experiences.
   */
  it('lists each merged page once, not once per half', () => {
    renderSettings();
    for (const gone of ['Roles & permissions', 'Tags', 'Inbound webhooks', 'Claude connector', 'Custom Domains']) {
      expect(screen.queryByRole('link', { name: gone })).not.toBeInTheDocument();
    }
    for (const kept of ['Team', 'Segments & tags', 'Domains', 'Webhooks', 'API & connector']) {
      expect(screen.getAllByRole('link', { name: kept }).length).toBeGreaterThan(0);
    }
  });
});
