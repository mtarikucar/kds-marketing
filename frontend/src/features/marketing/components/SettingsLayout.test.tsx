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
    // SEVEN groups over seventeen pages, from nine over forty-two two days
    // earlier. "Data" is gone as a group because all three of its pages went to
    // the Inbox, where the people they shape actually live.
    expect(screen.getByText('Your business', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Marketing', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Selling', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Channels & domains', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Developer & security', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Plan & access', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByText('Data')).not.toBeInTheDocument();
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
      expect(screen.getByText('Pazarlama', { selector: 'p' })).toBeInTheDocument();
      expect(screen.getByText('Uygulamaya dön')).toBeInTheDocument();
      expect(screen.getByText('İşletmen', { selector: 'p' })).toBeInTheDocument();
      expect(screen.getByText('Plan ve erişim', { selector: 'p' })).toBeInTheDocument();
      // Its neighbours, to prove the assertion is about a Turkish list rather
      // than about one string that happens to be translated. The two renamed
      // groups are here on purpose: a heading that lost its catalogue entry in
      // the merge would read as English in an otherwise Turkish list, which is
      // exactly the defect this test was written for.
      expect(screen.getByText('Kanallar ve alan adları', { selector: 'p' })).toBeInTheDocument();
      expect(screen.getByText('Satış', { selector: 'p' })).toBeInTheDocument();
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
  it('keeps the phone as ONE entry in the channels group', () => {
    renderSettings();
    // Inside the group, not merely somewhere on the page: the whole point of
    // the move is WHERE it lands, and the mobile strip renders every item flat.
    const group = screen.getByText('Channels & domains', { selector: 'p' })
      .parentElement as HTMLElement;
    expect(within(group).getByRole('link', { name: 'Voice AI' })).toBeInTheDocument();
    // The call log is a TAB of it since 2026-09-04 — what answers the line and
    // what it then did are one subject, and were two lines in this list.
    expect(screen.queryByRole('link', { name: 'Calls' })).not.toBeInTheDocument();
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
    const group = screen.getByText('Channels & domains', { selector: 'p' }).parentElement as HTMLElement;
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
    for (const gone of [
      'Roles & permissions', 'Inbound webhooks', 'Claude connector', 'Custom Domains',
      // The second pass. Three of these left Settings altogether.
      'Targets', 'Booking', 'Pipelines', 'Subscriptions', 'Order forms', 'Invoices',
      'Modules', 'Calls', 'Workflows', 'Research', 'Segments & tags', 'Custom Fields', 'Import',
    ]) {
      expect(screen.queryByRole('link', { name: gone })).not.toBeInTheDocument();
    }
    for (const kept of ['Team', 'Domains', 'Webhooks', 'API & connector', 'Selling', 'Business']) {
      expect(screen.getAllByRole('link', { name: kept }).length).toBeGreaterThan(0);
    }
  });
});
