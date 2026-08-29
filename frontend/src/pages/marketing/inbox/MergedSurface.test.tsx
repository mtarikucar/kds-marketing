import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import InboxPage from './InboxPage';

/**
 * The merged surface (spec §1): `/inbox` and `/leads` render the SAME
 * component and differ only in which tab opens.
 *
 * Both routes stay — they are members of the frozen 50-path set
 * (navigation.test.ts) and they are in people's bookmarks. What merges is the
 * page, not the URL space.
 */

const get = vi.fn();
const post = vi.fn().mockResolvedValue({ data: {} });
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel?: (s: unknown) => unknown) => {
    const state = { accessToken: 'tok', user: { role: 'MANAGER', id: 'u-1' } };
    return sel ? sel(state) : state;
  },
}));
vi.mock('../../../lib/env', () => ({ API_URL: 'http://test' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string | string[], d?: { defaultValue?: string } | string) =>
      (typeof d === 'string' ? d : d?.defaultValue) ??
      (Array.isArray(k) ? k[0] : k),
    i18n: { language: 'en' },
  }),
}));

// Konuşmalar is gated on conversationAi, exactly as the lead detail's tab is:
// GET /conversations is @RequiresFeature('conversationAi'), and `/leads` — the
// route that now reaches this component — carries no entitlement at all.
// Mutable so both outcomes are real renders rather than two files.
let FEATURES = new Set<string>();
let ENTITLEMENTS_LOADING = false;
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    has: (k?: string) => !k || FEATURES.has(k),
    isLoading: ENTITLEMENTS_LOADING,
  }),
}));

// The two heavy halves are stubbed down to the one fact each test reads: the
// conversation list reports which record is SELECTED (that is the state whose
// survival across a tab switch is under test), and the leads surface reports
// that it rendered and what the URL handed it.
vi.mock('./ConversationList', () => ({
  ConversationList: ({ conversations, selectedId, onSelect }: any) => (
    <div>
      <span data-testid="selected">selected:{selectedId ?? 'none'}</span>
      {(conversations ?? []).map((c: any) => (
        <button key={c.id} onClick={() => onSelect(c.id)}>
          {c.id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('./ThreadPane', () => ({ ThreadPane: () => null }));
vi.mock('./LeadContextPane', () => ({ LeadContextPane: () => null }));
vi.mock('../ChannelsSettingsPage', () => ({ default: () => <div>channels-page</div> }));
vi.mock('../settings/snippets', () => ({ default: () => <div>snippets-page</div> }));
vi.mock('../AgentStudioPage', () => ({ default: () => <div>agents-page</div> }));
vi.mock('../KnowledgeBasePage', () => ({ default: () => <div>knowledge-page</div> }));
vi.mock('../leads/LeadsPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="leads-surface">leads-embedded:{String(!!embedded)}</div>
  ),
}));

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {/* The real route table: same element, one prop apart. */}
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/leads" element={<InboxPage defaultTab="contacts" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sse')));
  FEATURES = new Set(['conversationAi']);
  ENTITLEMENTS_LOADING = false;
  get.mockReset();
  post.mockClear();
  get.mockImplementation((url: string) =>
    url === '/conversations'
      ? Promise.resolve({
          data: [
            { id: 'cA', status: 'OPEN', aiPaused: false, unreadCount: 0 },
            { id: 'cB', status: 'OPEN', aiPaused: false, unreadCount: 0 },
          ],
        })
      : Promise.resolve({
          data: { conversation: { id: 'x', aiPaused: false }, lead: null, messages: [], channel: null },
        }),
  );
});

describe('The merged surface — two tabs, one component', () => {
  it('opens /inbox on Konuşmalar', async () => {
    renderAt('/inbox');

    expect(await screen.findByRole('tab', { name: 'Konuşmalar' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Kişiler' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    // The tab is SELECTED and its panel is the one showing.
    await screen.findByText('cA');
  });

  it('opens /leads on Kişiler', async () => {
    renderAt('/leads');

    expect(await screen.findByRole('tab', { name: 'Kişiler' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Konuşmalar' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    // Embedded, so the host's header is the only header — see the next test.
    expect(await screen.findByTestId('leads-surface')).toHaveTextContent(
      'leads-embedded:true',
    );
  });

  it('shows ONE page header, not one per merged page', async () => {
    renderAt('/leads');
    await screen.findByTestId('leads-surface');

    // Anchor first: the page has rendered a heading, so counting them is
    // counting a settled page rather than an empty one.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('keeps the selected record when the tab changes', async () => {
    const user = userEvent.setup();
    renderAt('/inbox');

    await user.click(await screen.findByRole('button', { name: 'cA' }));
    await waitFor(() =>
      expect(screen.getByTestId('selected')).toHaveTextContent('selected:cA'),
    );

    // Away to Kişiler…
    await user.click(screen.getByRole('tab', { name: 'Kişiler' }));
    await screen.findByTestId('leads-surface');

    // …and back. Radix unmounts the inactive panel, so this only holds while
    // the selection lives in the page component ABOVE the tabs. It is asserted
    // rather than assumed because "by construction" is precisely the kind of
    // thing that stops being true later.
    await user.click(screen.getByRole('tab', { name: 'Konuşmalar' }));
    expect(await screen.findByTestId('selected')).toHaveTextContent('selected:cA');
  });

  it('lets either route reach either tab, so old ?tab= links keep resolving', async () => {
    renderAt('/leads?tab=inbox');

    expect(await screen.findByRole('tab', { name: 'Konuşmalar' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('The merged surface — a workspace without conversationAi', () => {
  // `/inbox` is entitlement-gated in navigation.ts; `/leads` is not. Merging
  // them puts a Konuşmalar tab in front of workspaces that could only ever see
  // it fail, so the gate moves WITH the item — navigation.ts's own rule, one
  // level down.
  beforeEach(() => {
    FEATURES = new Set();
  });

  it('drops the Konuşmalar tab entirely and lands on Kişiler', async () => {
    renderAt('/leads');

    // Anchor on the tab that survives the gate, so the absence below is
    // measured against a rendered strip rather than an unrendered page.
    const contacts = await screen.findByRole('tab', { name: 'Kişiler' });
    expect(contacts).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Konuşmalar' })).not.toBeInTheDocument();
  });

  it('does not strand /inbox on a tab that no longer exists', async () => {
    renderAt('/inbox');

    // The route asks for Konuşmalar; the entitlement says there isn't one.
    // Falling back keeps the page on a tab that exists rather than selecting
    // nothing and rendering a blank panel.
    expect(await screen.findByRole('tab', { name: 'Kişiler' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('never asks for conversations it is not allowed to have', async () => {
    renderAt('/leads');
    // Positive anchor BEFORE the absence: the page is settled, so "no call"
    // means the call was not made rather than not made YET.
    await screen.findByTestId('leads-surface');

    expect(get.mock.calls.map((c) => c[0])).not.toContain('/conversations');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('The merged surface — what /leads does not pay for', () => {
  it('does not open the conversation stream until Konuşmalar is opened', async () => {
    const user = userEvent.setup();
    renderAt('/leads');
    await screen.findByTestId('leads-surface');

    // Someone filtering their contact list is not running a live inbox; the
    // SSE connection and the 30 s poll are the inbox's cost, not theirs.
    expect(get.mock.calls.map((c) => c[0])).not.toContain('/conversations');

    await user.click(screen.getByRole('tab', { name: 'Konuşmalar' }));
    await screen.findByText('cA');
    expect(get.mock.calls.map((c) => c[0])).toContain('/conversations');
  });
});

describe('The merged surface — while the entitlement answer is still in flight', () => {
  // useEntitlements fails CLOSED while /billing/summary is loading. That is the
  // right default for a nav rail, and the wrong one here: applied literally it
  // would open /inbox on Kişiler for the first render — mounting the leads
  // table and firing its three requests — and then flip back a moment later.
  // Only a RESOLVED "no" is allowed to move anybody off the tab they asked for.
  beforeEach(() => {
    ENTITLEMENTS_LOADING = true;
    FEATURES = new Set();
  });

  it('leaves /inbox on Konuşmalar and does not mount the leads table', async () => {
    renderAt('/inbox');

    expect(await screen.findByRole('tab', { name: 'Konuşmalar' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByTestId('leads-surface')).not.toBeInTheDocument();
  });

  it('still fetches nothing it may not be allowed to fetch', async () => {
    renderAt('/inbox');
    // Positive anchor: the tab strip is rendered, so the page has settled and
    // "no call" is a decision rather than a race.
    await screen.findByRole('tab', { name: 'Konuşmalar' });

    expect(get.mock.calls.map((c) => c[0])).not.toContain('/conversations');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
