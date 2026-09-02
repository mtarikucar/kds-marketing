import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { MERGED_SURFACE_ROUTES } from '../../../App';

/**
 * The route wiring, asserted against THE ROUTE TABLE THAT SHIPS.
 *
 * `/inbox` and `/leads` both render the person-primary surface, and after the
 * 2026-08-29 correction they render it identically — there are no tabs left for
 * them to differ about. Both paths stay: they are members of the frozen 50-path
 * set (navigation.test.ts) and they are in people's bookmarks. What merged is
 * the page, not the URL space.
 *
 * These tests import `MERGED_SURFACE_ROUTES` from App.tsx rather than building a
 * two-line copy of it. The copy is why this file's predecessor proved nothing:
 * deleting `defaultTab="contacts"` from App.tsx left all eleven of its tests
 * green while `/leads` opened on the wrong tab, because the fixture still
 * carried the prop the app had lost.
 */

const get = vi.fn().mockResolvedValue({ data: [] });
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => get(...a), post: vi.fn().mockResolvedValue({ data: {} }) },
}));

const listLeads = vi.fn();
vi.mock('../../../features/marketing/api/leads.service', () => ({
  listLeads: (...a: unknown[]) => listLeads(...a),
}));
vi.mock('../../../features/marketing/api/conversations.service', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  startConversation: vi.fn(),
}));

// App.tsx's ~100 page imports are lazy(), so importing the module loads none of
// them — but the layout/guard shells are real imports, and the components
// barrel drags the SIP.js webphone into jsdom. None of it is under test here:
// this file mounts two route ELEMENTS, not the app shell.
vi.mock('../../../features/marketing/components/MarketingLayout', () => ({ default: () => null }));
vi.mock('../../../features/platform/components/PlatformLayout', () => ({ default: () => null }));
vi.mock('../../../features/marketing/hooks/useReferralCapture', () => ({
  useReferralCapture: () => {},
}));
vi.mock('../leadDetail/LeadHeaderActions', () => ({ default: () => null }));
vi.mock('../../../features/marketing/components/LeadStream', () => ({
  default: ({ leadId }: { leadId: string }) => <div data-testid="stream">stream:{leadId}</div>,
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel?: (s: unknown) => unknown) => {
    const state = { accessToken: 'tok', user: { role: 'MANAGER', id: 'u-1' } };
    return sel ? sel(state) : state;
  },
}));
vi.mock('../../../lib/env', () => ({ API_URL: 'http://test' }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Mutable: the calls arrangement is the ONE left view that carries an
// entitlement (`/calls` is `feature: 'telephony'` in navigation.ts).
const entitlements = vi.hoisted(() => ({ telephony: true }));
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    has: (k?: string) => (k === 'telephony' ? entitlements.telephony : true),
    isLoading: false,
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string | string[], d?: { defaultValue?: string } | string) =>
      (typeof d === 'string' ? d : d?.defaultValue) ?? (Array.isArray(k) ? k[0] : k),
    i18n: { language: 'tr' },
  }),
}));

const PERSON = {
  id: 'p1',
  businessName: 'Acme',
  contactPerson: 'Ayşe',
  businessType: 'OTHER',
  source: 'OTHER',
  status: 'NEW',
  priority: 'MEDIUM',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  lastActivityAt: '2026-01-01T00:00:00Z',
  unreadCount: 0,
  lastMessageAt: null,
  lastMessagePreview: null,
};

/** The live URL, so a test can assert what a click did NOT write into it. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-search">{loc.search}</div>;
}

/**
 * The surface behind these routes is lazy, and on a loaded machine the first
 * mount of its chunk regularly runs past testing-library's 1000 ms default —
 * the failure is a spinner still on screen, not a wrong render. Every wait for
 * the FIRST element of a cold mount uses this instead, so a slow transform is
 * a slow test rather than a red one.
 */
const COLD_MOUNT = { timeout: 15_000 };

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          {/* THE route table, imported — not a second copy of it. */}
          {MERGED_SURFACE_ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The list query, ignoring the three `limit: 1` chip-count probes. */
const listCalls = () =>
  listLeads.mock.calls.map((c) => c[0]).filter((p: { limit?: number }) => p.limit !== 1);

/**
 * Two calls, and the difference between them is the whole point of the row
 * test: an INBOUND call whose number matched no lead has `leadId: null`
 * (types.ts:433), so there is nobody to hand over.
 */
const CALLS = [
  {
    id: 'c-matched',
    marketingUserId: null,
    leadId: 'p1',
    direction: 'OUTBOUND',
    toPhone: '+905551112233',
    providerId: 'x',
    status: 'CONNECTED',
    startedAt: '2026-08-01T00:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  },
  {
    id: 'c-orphan',
    marketingUserId: null,
    leadId: null,
    direction: 'INBOUND',
    toPhone: '+905559998877',
    providerId: 'x',
    status: 'NO_ANSWER',
    startedAt: '2026-08-01T00:00:00Z',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  },
];

beforeEach(() => {
  entitlements.telephony = true;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no sse')));
  get.mockReset();
  get.mockImplementation((url: string) =>
    url === '/calls'
      ? Promise.resolve({
          data: { data: CALLS, meta: { total: 2, page: 1, limit: 20, totalPages: 1 } },
        })
      : Promise.resolve({ data: [] }),
  );
  listLeads.mockReset();
  listLeads.mockImplementation((p: { limit?: number }) =>
    Promise.resolve({
      data: p.limit === 1 ? [] : [PERSON],
      meta: { total: 1, page: 1, limit: p.limit ?? 25, totalPages: 1 },
    }),
  );
});

describe('The person surface — two routes, one page', () => {
  it('renders the three columns at /inbox', async () => {
    renderAt('/inbox');
    expect(await screen.findByTestId('person-surface', {}, COLD_MOUNT)).toBeInTheDocument();
    expect(await screen.findByTestId('person-row-p1')).toBeInTheDocument();
  });

  it('renders the same three columns at /leads', async () => {
    renderAt('/leads');
    expect(await screen.findByTestId('person-surface', {}, COLD_MOUNT)).toBeInTheDocument();
    expect(await screen.findByTestId('person-row-p1')).toBeInTheDocument();
  });

  // The dashboard's triage deep link (NeedsAttention.tsx, DashboardHero.tsx).
  // It predates this surface and now lands on it.
  it('keeps /leads?assignmentStatus=unassigned resolving, filtered and lit', async () => {
    renderAt('/leads?assignmentStatus=unassigned');

    await screen.findByTestId('person-row-p1');
    expect(screen.getByRole('button', { name: /Atanmamış/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(listCalls()[0]).toMatchObject({ assignmentStatus: 'unassigned' });
  });
});

/**
 * The fifth arrangement of the left column. `/calls` is the page, embedded —
 * the same "mount, don't link" rule the other three follow — with two things
 * the others do not have: an entitlement, and rows that may match nobody.
 */
describe('The person surface — the calls arrangement', () => {
  it('offers the tab to a telephony-entitled workspace and mounts the call log', async () => {
    const user = userEvent.setup();
    renderAt('/inbox');

    await user.click(await screen.findByTestId('view-tab-calls'));
    expect(await screen.findByText('+905551112233')).toBeInTheDocument();
  });

  /**
   * A SELECTION, never a navigation — the contract every arrangement of this
   * surface shares. Clicking the number of a call that matched a lead puts that
   * person in the other two columns without leaving the screen.
   */
  it('hands a person over when the call matched one', async () => {
    const user = userEvent.setup();
    renderAt('/inbox');

    await user.click(await screen.findByTestId('view-tab-calls'));
    await user.click(await screen.findByTestId('call-row-person-c-matched'));

    // The middle column is the stream for that person, and the record card
    // resolved to them.
    expect(await screen.findByTestId('stream')).toHaveTextContent('stream:p1');
  });

  /**
   * The half that is easy to get wrong. `SalesCall.leadId` is nullable: an
   * inbound call from a number no lead carries has nobody behind it. A button
   * there would select nothing — worse than plain text, because it promises.
   */
  it('leaves a call that matched nobody as plain text, not a dead button', async () => {
    const user = userEvent.setup();
    renderAt('/inbox');

    await user.click(await screen.findByTestId('view-tab-calls'));

    // Positive anchor: the row IS rendered.
    expect(await screen.findByText('+905559998877')).toBeInTheDocument();
    expect(screen.queryByTestId('call-row-person-c-orphan')).not.toBeInTheDocument();
    // …while the matched row's button is there, so the absence is a decision.
    expect(screen.getByTestId('call-row-person-c-matched')).toBeInTheDocument();
  });

  it('withholds the tab from a workspace without the telephony entitlement', async () => {
    entitlements.telephony = false;
    renderAt('/inbox');

    // Positive anchor: the other four arrangements are offered.
    expect(await screen.findByTestId('view-tab-list')).toBeInTheDocument();
    expect(screen.getByTestId('view-tab-tasks')).toBeInTheDocument();
    expect(screen.queryByTestId('view-tab-calls')).not.toBeInTheDocument();
  });

  /**
   * A bookmark outliving an entitlement. Hiding only the TAB would leave
   * `?left=calls` rendering a column whose every request 503s, with no lit tab
   * and no way to see what happened — so the VALUE falls back to Liste, the
   * same rule InboxPage applies to an unknown `?tab=`.
   */
  it('falls back to Liste for a stale ?left=calls rather than blanking the column', async () => {
    entitlements.telephony = false;
    renderAt('/inbox?left=calls');

    expect(await screen.findByTestId('person-row-p1')).toBeInTheDocument();
    expect(screen.getByTestId('view-tab-list')).toHaveAttribute('aria-selected', 'true');
    expect(get).not.toHaveBeenCalledWith('/calls', expect.anything());
  });

  /**
   * `?tab=` already has two owners on this ONE url — the surface's config
   * pages and the embedded TasksPage's filters — and they stay disjoint by
   * coincidence, not design (see tabParam.contract.test.ts). A third writer
   * ends the coincidence: a left column writing `?tab=dialer` would hand both
   * other readers a value each of them falls back on. So the embedded CallsPage
   * drives its tab from local state and writes NOTHING.
   */
  it('writes no ?tab= of its own when its tab is switched', async () => {
    const user = userEvent.setup();
    renderAt('/inbox');

    await user.click(await screen.findByTestId('view-tab-calls'));
    await screen.findByText('+905551112233');
    await user.click(screen.getByRole('tab', { name: 'Power Dialer' }));

    // The tab really changed — otherwise "no parameter" would be vacuous.
    expect(screen.getByRole('tab', { name: 'Power Dialer' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('location-search').textContent).not.toContain('tab=');
  });
});