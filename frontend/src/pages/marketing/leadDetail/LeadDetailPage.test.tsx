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

// Mesaj is gated on conversationAi (and fax on `fax`); this workspace has the
// former and not the latter.
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ has: (k?: string) => k === 'conversationAi' }),
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
vi.mock('./ActivityTimelineTab', () => ({ default: () => null }));
vi.mock('./ConversationsTab', () => ({ default: () => null }));
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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/leads/l1']}>
        <Routes>
          <Route path="/leads" element={<div data-testid="leads-list" />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

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

// The five tabs ARE the lead record's shape — spec §2 fixes both the set and
// the order (Hareketler | Konuşmalar | Satış | Teklifler | Görevler). Stubbing
// the tab components (above) proves nothing about the strip itself: with only
// those stubs, deleting `<TabsTrigger value="conversations">` or swapping two
// triggers fails no test at all. This asserts the ORDERED list of accessible
// names, not mere presence, because a strip that silently reorders itself
// moves the default tab out from under every muscle-memory click.
describe('LeadDetailPage — the tab strip', () => {
  beforeEach(() => {
    getLead.mockReset();
    getLead.mockResolvedValue(LEAD);
    listConversations.mockReset();
    listConversations.mockResolvedValue([]);
  });

  it('offers exactly the five lead tabs, in the spec’s order', async () => {
    renderPage();
    // Positive anchor first: the page is SETTLED before any list is measured.
    // `getAllByRole('tab')` against a still-loading page returns [] and would
    // satisfy a naive length assertion instantly.
    await screen.findByRole('tab', { name: 'Konuşmalar' });

    const tabs = screen.getAllByRole('tab').map((el) => el.textContent?.trim());
    expect(tabs).toEqual(['Etkinlik', 'Konuşmalar', 'Satış', 'Teklifler (0)', 'Görevler (0)']);
  });
});

// The header's Mesaj action reaches ACROSS to the tab strip: this app has no
// per-thread URL, so "open the conversation" can only mean "bring Konuşmalar
// forward". That is a wire between two components and belongs here, not in
// either one's own test — LeadHeaderActions.test.tsx can only prove the
// callback fires.
describe('LeadDetailPage — Mesaj brings the Konuşmalar tab forward', () => {
  beforeEach(() => {
    getLead.mockReset();
    getLead.mockResolvedValue({ ...LEAD, phone: '+905551112233' });
    listConversations.mockReset();
    listConversations.mockResolvedValue([{ id: 'c1', status: 'OPEN', aiPaused: false, unreadCount: 0 }]);
  });

  it('selects Konuşmalar when the lead already has a thread', async () => {
    const user = userEvent.setup();
    renderPage();

    // Activities is the tab the page opens on…
    const activities = await screen.findByRole('tab', { name: 'Etkinlik' });
    expect(activities).toHaveAttribute('aria-selected', 'true');

    const message = screen.getByRole('button', { name: /Mesaj/ });
    await waitFor(() => expect(message).toBeEnabled());
    await user.click(message);

    // …and Mesaj moves it, rather than opening a start flow on a lead that is
    // already mid-conversation.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Konuşmalar' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
