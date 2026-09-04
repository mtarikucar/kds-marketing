import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * THE SIX PAGES THAT ABSORBED ANOTHER.
 *
 * Six pairs of settings entries were one job each, split in two: Team and the
 * roles its members carry, Segments and Tags, the two Domains, the two Webhook
 * directions, API keys and the Claude connector, the voice greeting and the
 * phone tree. Each pair is now one page with tabs.
 *
 * What is asserted here is the SHELL — that both halves are present and that
 * `?tab=` names them. The halves keep their own tests; the thing that did not
 * exist before, and could silently render an empty page, is the wrapper.
 *
 * Every child is stubbed. These shells exist to place two components on one
 * page, and loading the real ones would test their data-fetching instead.
 */

const stub = (name: string) => ({ default: () => <div>{name}-stub</div> });

vi.mock('./SendingDomainsPage', () => stub('sending'));
vi.mock('./CustomDomainsPage', () => stub('custom'));
vi.mock('./webhooks/WebhooksPage', () => stub('outgoing-hooks'));
vi.mock('./inboundWebhooks', () => stub('inbound-hooks'));
vi.mock('./apiKeys/ApiKeysPage', () => stub('api-keys'));
vi.mock('./mcpConsole/McpConsolePage', () => stub('connector'));
vi.mock('../users', () => stub('members'));
vi.mock('./roles/RolesPage', () => stub('roles'));
vi.mock('../crm/segments/SegmentsPage', () => stub('segments'));
vi.mock('../crm/tags/TagsPage', () => stub('tags'));
vi.mock('../VoicePage', () => stub('assistant'));
vi.mock('../voice/ivr/IvrMenusPage', () => stub('phone-tree'));
vi.mock('../CallsPage', () => stub('call-log'));
vi.mock('../targets', () => stub('targets'));
vi.mock('../BookingSettingsPage', () => stub('booking'));
vi.mock('./roles/RolesPage', () => stub('roles'));
vi.mock('../strategy/StrategyConsolePage', () => stub('strategy'));
vi.mock('../automations/AutomationsListPage', () => stub('workflows'));
vi.mock('../research/ResearchSettingsPage', () => stub('research'));
vi.mock('../products/ProductsPage', () => stub('products'));
vi.mock('../orderForms/OrderFormsPage', () => stub('order-forms'));
vi.mock('../subscriptions/SubscriptionsPage', () => stub('subs'));
vi.mock('../invoices', () => stub('invoices'));
vi.mock('../billing/index', () => stub('plan'));
vi.mock('./modules', () => stub('modules'));
// Every feature granted, so a gated tab's ABSENCE in another test is about the
// gate rather than about a query that never resolved.
const ungate = vi.fn(() => true);
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    // Mirrors the real hook: an item with NO feature is always visible, and
    // only a named one is asked about. A mock that gated everything would make
    // the assertions below pass for the wrong reason.
    has: (f?: string) => (f === undefined ? true : ungate()),
    isLoading: false,
    isError: false,
    entitledModules: [],
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string } | string) =>
      (typeof o === 'string' ? o : o?.defaultValue) ?? k,
    i18n: { language: 'en' },
  }),
}));

import DomainsPage from './DomainsPage';
import GrowthEnginePage from '../strategy/GrowthEnginePage';
import SellingPage from '../products/SellingPage';
import PlanAndAccessPage from '../billing/PlanAndAccessPage';
import WebhooksHubPage from './WebhooksHubPage';
import ApiAccessPage from './ApiAccessPage';
import TeamPage from '../TeamPage';
import AudiencePage from '../crm/AudiencePage';
import VoiceHubPage from '../VoiceHubPage';

type Shell = {
  name: string;
  Page: () => JSX.Element;
  title: string;
  first: string;
  second: string;
  secondTab: string;
};

const SHELLS: Shell[] = [
  { name: 'Domains', Page: DomainsPage, title: 'Domains', first: 'sending-stub', second: 'custom-stub', secondTab: 'custom' },
  { name: 'Webhooks', Page: WebhooksHubPage, title: 'Webhooks', first: 'outgoing-hooks-stub', second: 'inbound-hooks-stub', secondTab: 'inbound' },
  { name: 'API access', Page: ApiAccessPage, title: 'API access', first: 'api-keys-stub', second: 'connector-stub', secondTab: 'connector' },
  { name: 'Team', Page: TeamPage, title: 'Team', first: 'members-stub', second: 'roles-stub', secondTab: 'roles' },
  { name: 'Audience', Page: AudiencePage, title: 'Segments & tags', first: 'segments-stub', second: 'tags-stub', secondTab: 'tags' },
  { name: 'Voice', Page: VoiceHubPage, title: 'Voice', first: 'assistant-stub', second: 'call-log-stub', secondTab: 'calls' },
  // The second pass, 2026-09-04.
  { name: 'Strategy', Page: GrowthEnginePage, title: 'Strategy', first: 'strategy-stub', second: 'research-stub', secondTab: 'research' },
  { name: 'Selling', Page: SellingPage, title: 'Selling', first: 'products-stub', second: 'invoices-stub', secondTab: 'invoices' },
  { name: 'Plan & access', Page: PlanAndAccessPage, title: 'Plan & access', first: 'plan-stub', second: 'modules-stub', secondTab: 'modules' },
];

function renderAt({ Page }: Shell, search = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/x${search}`]}>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe.each(SHELLS)('$name — one page, two halves', (shell) => {
  beforeEach(() => ungate.mockReturnValue(true));

  it('names the page once, at the top', async () => {
    renderAt(shell);
    expect(await screen.findByRole('heading', { name: shell.title })).toBeInTheDocument();
  });

  it('opens on the first half by default', async () => {
    renderAt(shell);
    expect(await screen.findByText(shell.first)).toBeInTheDocument();
  });

  it('opens the second half straight from the URL', async () => {
    // This is what every redirected old path relies on. If `?tab=` did not
    // select, a bookmark to the absorbed page would land on the wrong half —
    // which reads as "the page I wanted is gone".
    renderAt(shell, `?tab=${shell.secondTab}`);
    expect(await screen.findByText(shell.second)).toBeInTheDocument();
  });

  it('falls back to the first half on a tab name that is not one of its own', async () => {
    renderAt(shell, '?tab=nonsense');
    expect(await screen.findByText(shell.first)).toBeInTheDocument();
  });

  it('swaps the half when the other tab is clicked', async () => {
    const user = userEvent.setup();
    renderAt(shell);
    await screen.findByText(shell.first);

    await user.click(screen.getAllByRole('tab', { selected: false })[0]);

    await waitFor(() => expect(screen.queryByText(shell.first)).not.toBeInTheDocument());
  });
});

/**
 * THE GATE A MERGE DROPS WITHOUT ANYONE NOTICING.
 *
 * Several pages that became tabs carried an entitlement of their own: /calls
 * needed `telephony`, /automations `workflows`, /invoices `invoicing`,
 * /booking `funnels`. Folding one into a page with a different gate silently
 * drops that check, and the workspace is offered a tab for a feature it has not
 * bought — a click, a blank panel, no explanation.
 *
 * A shorter list you cannot use is worse than the long one it replaced.
 */
describe('a merged page only shows the halves this workspace has', () => {
  function renderUngated(Page: () => JSX.Element, search = '') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/x${search}`]}>
          <Page />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('hides the gated half and keeps the ungated ones', async () => {
    ungate.mockReturnValue(false);
    renderUngated(SellingPage);
    // Products and order forms carry no gate of their own.
    expect(await screen.findByText('products-stub')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /order forms/i })).toBeInTheDocument();
    // Invoices needed `invoicing` before it was a tab, and still does.
    expect(screen.queryByRole('tab', { name: /invoices/i })).not.toBeInTheDocument();
  });

  it('will not open a gated half from the URL either', async () => {
    // Otherwise the gate is a decoration: anyone who knows the tab name types
    // it and lands on the panel the plan does not include.
    ungate.mockReturnValue(false);
    renderUngated(SellingPage, '?tab=invoices');
    expect(await screen.findByText('products-stub')).toBeInTheDocument();
    expect(screen.queryByText('invoices-stub')).not.toBeInTheDocument();
  });

  it('shows it again once the workspace is entitled', async () => {
    ungate.mockReturnValue(true);
    renderUngated(SellingPage, '?tab=invoices');
    expect(await screen.findByText('invoices-stub')).toBeInTheDocument();
  });
});
