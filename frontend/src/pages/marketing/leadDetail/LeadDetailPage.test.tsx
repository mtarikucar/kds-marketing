import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import LeadDetailPage from './LeadDetailPage';

const getLead = vi.fn();
const deleteLead = vi.fn();
vi.mock('../../../features/marketing/api/leads.service', () => ({
  getLead: (...a: unknown[]) => getLead(...a),
  deleteLead: (...a: unknown[]) => deleteLead(...a),
  updateLeadStatus: vi.fn(),
  createLeadActivity: vi.fn(),
  createOffer: vi.fn(),
  sendOffer: vi.fn(),
  deleteOffer: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  deleteTask: vi.fn(),
  convertLead: vi.fn(),
}));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { role: 'MANAGER', id: 'u1' } }),
}));

vi.mock('../../../features/marketing/hooks/useBreadcrumbLabel', () => ({
  useBreadcrumbLabel: vi.fn(),
}));

// Mesaj AND the Konuşmalar tab are gated on conversationAi (fax on `fax`,
// Ara on `telephony`). Mutable so the same page can be rendered for an
// entitled and an un-entitled workspace — the gate's two outcomes are
// different renders, not different files. Read at call time, never inside the
// hoisted factory, so there is no TDZ.
let FEATURES = new Set<string>();
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ has: (k?: string) => !k || FEATURES.has(k) }),
}));

// The side panels/tabs fire their own queries and are irrelevant to the
// header-level delete flow under test — stub them out.
vi.mock('../../../features/marketing/components', () => ({
  LeadStatusBadge: () => null,
  AssignCell: () => null,
  // Real ClickToDialButton drags in the SIP.js webphone; the header only needs
  // to prove it mounts it (LeadHeaderActions.test.tsx owns the rest).
  ClickToDialButton: () => <div data-testid="click-to-dial" />,
}));

// LeadHeaderActions is REAL here — its wiring into the tab strip is the thing
// under test below — so its two reads are stubbed instead.
const listConversations = vi.fn();
vi.mock('../../../features/marketing/api/conversations.service', () => ({
  listConversations: (...a: unknown[]) => listConversations(...a),
  startConversation: vi.fn(),
}));
vi.mock('./ContactInfo', () => ({ default: () => null }));
vi.mock('./WalletPanel', () => ({ WalletPanel: () => null }));
vi.mock('./CompanyPanel', () => ({ CompanyPanel: () => null }));
vi.mock('./LogActivityDialog', () => ({ default: () => null }));
// Rendered (not null) so the Akış PANEL is an assertable element rather than an
// absence that is trivially true — the un-entitled case below turns on the
// panel still BEING there, which is the whole improvement over v2.283.0.
vi.mock('../../../features/marketing/components/LeadStream', () => ({
  default: () => <div data-testid="stream-panel" />,
}));
vi.mock('./SalesTab', () => ({ default: () => null }));
vi.mock('./OffersTab', () => ({ default: () => null }));
vi.mock('./TasksTab', () => ({ default: () => null }));
vi.mock('./ConvertDialog', () => ({ default: () => null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

const LEAD = {
  id: 'l1',
  businessName: 'Acme',
  contactPerson: 'Jane',
  status: 'NEW',
  convertedTenantId: null,
  assignedTo: null,
  companyId: null,
  offers: [],
  tasks: [],
  activities: [],
  createdAt: '2026-06-01T00:00:00Z',
};

const tree = (qc: QueryClient) => (
  <QueryClientProvider client={qc}>
    <MemoryRouter initialEntries={['/leads/l1']}>
      <Routes>
        <Route path="/leads" element={<div data-testid="leads-list" />} />
        <Route path="/leads/:id" element={<LeadDetailPage />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(tree(qc));
  return { ...r, rerenderPage: () => r.rerender(tree(qc)) };
}

beforeEach(() => {
  // Default: a fully-entitled workspace, so an individual test only has to say
  // what it takes AWAY.
  FEATURES = new Set(['conversationAi', 'telephony']);
});

// Deleting a lead is destructive and must be gated by the design-system
// ConfirmDialog (not window.confirm), firing only on the explicit confirm.
describe('LeadDetailPage — delete confirmation', () => {
  beforeEach(() => {
    getLead.mockReset();
    getLead.mockResolvedValue(LEAD);
    listConversations.mockReset();
    listConversations.mockResolvedValue([]);
    deleteLead.mockReset();
    deleteLead.mockResolvedValue({});
  });

  it('opens a confirm dialog and only deletes after the destructive confirm', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Acme');

    await user.click(screen.getByRole('button', { name: /delete/i }));
    // The header click opens the ConfirmDialog; nothing is deleted yet.
    expect(deleteLead).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteLead).toHaveBeenCalledWith('l1'));
    // Successful delete navigates back to the list.
    await waitFor(() => expect(screen.getByTestId('leads-list')).toBeInTheDocument());
  });

  it('does not delete when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Acme');

    await user.click(screen.getByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(deleteLead).not.toHaveBeenCalled();
  });
});

// The FOUR tabs ARE the lead record's shape — the 2026-08-29 spec fixes both
// the set and the order (Akış | Satış | Teklifler | Görevler). v2.283.0 pinned
// FIVE here, and the first two of them (Hareketler, Konuşmalar) were the same
// person's history shown twice in two different shapes; the merged stream
// dissolves the pair into one. Stubbing the tab components (above) proves
// nothing about the strip itself: with only those stubs, deleting a
// `<TabsTrigger>` or swapping two of them fails no test at all. This asserts
// the ORDERED list of accessible names, not mere presence, because a strip that
// silently reorders itself moves the default tab out from under every
// muscle-memory click.
describe('LeadDetailPage — the tab strip', () => {
  beforeEach(() => {
    getLead.mockReset();
    getLead.mockResolvedValue(LEAD);
    listConversations.mockReset();
    listConversations.mockResolvedValue([]);
  });

  it('offers exactly the four lead tabs, in the spec’s order', async () => {
    renderPage();
    // Positive anchor first: the page is SETTLED before any list is measured.
    // `getAllByRole('tab')` against a still-loading page returns [] and would
    // satisfy a naive length assertion instantly.
    await screen.findByRole('tab', { name: 'Akış' });

    const tabs = screen.getAllByRole('tab').map((el) => el.textContent?.trim());
    expect(tabs).toEqual(['Akış', 'Satış', 'Teklifler (0)', 'Görevler (0)']);
  });

  // The un-entitled case — and it is now the MORE interesting half, not the
  // lesser one. v2.283.0 hid Konuşmalar outright for a workspace without
  // `conversationAi`, because `GET /conversations` sits behind
  // @RequiresFeature and the tab's only reachable state was "Konuşmalar
  // yüklenemedi." — a tab that lands on a page you cannot open.
  //
  // `GET /leads/:id/timeline` carries no route-level gate on purpose: it reads
  // the entitlement PER SOURCE and names the withheld one in `gated`, so the
  // workspace keeps its activities and is told, in billing's language rather
  // than support's, what it is not seeing. There is no longer a state this tab
  // lands on that it cannot open, so the tab no longer moves with the gate.
  it('keeps Akış, and the same four tabs, for a workspace without conversationAi', async () => {
    FEATURES = new Set(['telephony']);
    renderPage();
    // Anchor on a tab that is not the subject, so the list below is measured
    // against a rendered strip rather than an empty one.
    await screen.findByRole('tab', { name: 'Satış' });

    const tabs = screen.getAllByRole('tab').map((el) => el.textContent?.trim());
    expect(tabs).toEqual(['Akış', 'Satış', 'Teklifler (0)', 'Görevler (0)']);
    // Trigger AND content. The PANEL is the point: an un-entitled workspace
    // still gets this person's history, and LeadStream is what tells it which
    // source is withheld and why.
    expect(screen.getByTestId('stream-panel')).toBeInTheDocument();
  });

  // What the old "falls back rather than stranding" case was really protecting:
  // page state naming a tab that the render then gates away, leaving Radix with
  // nothing selected and the user on a blank panel. With one ungated set of
  // tabs that is structurally impossible, and this is the test that says so —
  // take the entitlement away mid-session and find the same four tabs with the
  // same one still selected.
  it('does not lose the selected tab when an entitlement disappears', async () => {
    const user = userEvent.setup();
    const { rerenderPage } = renderPage();

    await user.click(await screen.findByRole('tab', { name: 'Satış' }));
    expect(screen.getByRole('tab', { name: 'Satış' })).toHaveAttribute('aria-selected', 'true');

    FEATURES = new Set(['telephony']);
    rerenderPage();

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Satış' })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(screen.getAllByRole('tab').map((el) => el.textContent?.trim())).toEqual([
      'Akış',
      'Satış',
      'Teklifler (0)',
      'Görevler (0)',
    ]);
  });
});

// The header's Mesaj action reaches ACROSS to the tab strip: this app has no
// per-thread URL, so "open the conversation" can only mean "bring this person's
// stream forward". That is a wire between two components and belongs here, not
// in either one's own test — LeadHeaderActions.test.tsx can only prove the
// callback fires.
describe('LeadDetailPage — Mesaj brings the Akış tab forward', () => {
  beforeEach(() => {
    getLead.mockReset();
    getLead.mockResolvedValue({ ...LEAD, phone: '+905551112233' });
    listConversations.mockReset();
    listConversations.mockResolvedValue([{ id: 'c1', status: 'OPEN', aiPaused: false, unreadCount: 0 }]);
  });

  it('returns to Akış from another tab when the lead already has a thread', async () => {
    const user = userEvent.setup();
    renderPage();

    // Deliberately NOT starting on Akış. It is the default tab now, so
    // asserting it is selected after clicking Mesaj would pass just as well
    // with the wire cut — the rep has to be somewhere else first.
    await user.click(await screen.findByRole('tab', { name: 'Teklifler (0)' }));
    expect(screen.getByRole('tab', { name: 'Akış' })).toHaveAttribute('aria-selected', 'false');

    const message = screen.getByRole('button', { name: /Mesaj/ });
    await waitFor(() => expect(message).toBeEnabled());
    await user.click(message);

    // …and Mesaj moves it, rather than opening a start flow on a lead that is
    // already mid-conversation.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Akış' })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
