import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import LeadDetailPage from './LeadDetailPage';

/**
 * The header's state must not survive a lead switch — spec §3 by way of a bug
 * this repo has already paid for three times.
 *
 * `LeadDetailPage` early-returns on `isLoading`, and React Query's `isLoading`
 * is `isPending && isFetching` — FALSE the moment the target lead is already in
 * the cache. So navigating from lead A to an ALREADY-CACHED lead B re-renders
 * the page instead of unmounting it, and every `useState(props.x)` inside the
 * header keeps lead A's value: `ClickToDialButton` seeds its number with
 * `useState(defaultPhone || '')`, which never runs again. Pressing Ara then
 * POSTs `{ toPhone: <lead A's number>, leadId: 'B' }` — the wrong person is
 * rung and the activity is mirrored onto the wrong lead.
 *
 * WalletPanel (`amount resets per lead`), TasksTab (`draft resets per lead`)
 * and LogActivityDialog (a `useEffect` keyed on `leadId`, with the comment
 * explaining exactly this) already guard against it. This file is the fourth.
 *
 * Two things make this test load-bearing rather than decorative:
 *   1. ClickToDialButton is the REAL component, not a stub. The bug IS its
 *      `useState` seeding; a stub that re-reads its props every render would
 *      pass with the bug still present.
 *   2. The navigation is a REAL route change between two CACHED leads, and the
 *      test asserts the PAGE did not unmount across it (same tab DOM node
 *      before and after). A test that merely remounts the header passes
 *      trivially and proves nothing.
 */

const getLead = vi.fn();
vi.mock('../../../features/marketing/api/leads.service', () => ({
  getLead: (...a: unknown[]) => getLead(...a),
  deleteLead: vi.fn(),
  updateLeadStatus: vi.fn(),
  createLeadActivity: vi.fn(),
  createOffer: vi.fn(),
  sendOffer: vi.fn(),
  deleteOffer: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  deleteTask: vi.fn(),
  convertLead: vi.fn(),
  reopenLead: vi.fn(),
}));

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
  },
}));

const listConversations = vi.fn();
vi.mock('../../../features/marketing/api/conversations.service', () => ({
  listConversations: (...a: unknown[]) => listConversations(...a),
  startConversation: vi.fn(),
}));

// The SIP.js webphone the real ClickToDialButton reaches for — stubbed so the
// component itself can stay real.
vi.mock('../../../features/marketing/webphone/WebphoneHost', () => ({
  expectRingback: vi.fn(),
  setActiveCallId: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../../store/marketingAuthStore', () => ({
  useMarketingAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { role: 'MANAGER', id: 'u1' } }),
}));

vi.mock('../../../features/marketing/hooks/useBreadcrumbLabel', () => ({
  useBreadcrumbLabel: vi.fn(),
}));

// Both header actions are on, so both halves of the header's state are in play.
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    has: (k?: string) => !k || k === 'conversationAi' || k === 'telephony',
  }),
}));

// Only the barrel's OTHER exports are stubbed. ClickToDialButton is passed
// through for real — it is the subject.
vi.mock('../../../features/marketing/components', async () => ({
  LeadStatusBadge: () => null,
  AssignCell: () => null,
  ClickToDialButton: (
    await vi.importActual<typeof import('../../../features/marketing/components/ClickToDialButton')>(
      '../../../features/marketing/components/ClickToDialButton',
    )
  ).default,
}));

vi.mock('./ContactInfo', () => ({ default: () => null }));
vi.mock('./WalletPanel', () => ({ WalletPanel: () => null }));
vi.mock('./CompanyPanel', () => ({ CompanyPanel: () => null }));
vi.mock('./LogActivityDialog', () => ({ default: () => null }));
vi.mock('../../../features/marketing/components/LeadStream', () => ({ default: () => null }));
vi.mock('./SalesTab', () => ({ default: () => null }));
vi.mock('./OffersTab', () => ({ default: () => null }));
vi.mock('./TasksTab', () => ({ default: () => null }));
vi.mock('./ConvertDialog', () => ({ default: () => null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'tr' },
  }),
}));

const lead = (id: string, businessName: string, phone: string) => ({
  id,
  businessName,
  contactPerson: 'Jane',
  phone,
  status: 'NEW',
  convertedTenantId: null,
  assignedTo: null,
  companyId: null,
  offers: [],
  tasks: [],
  activities: [],
  createdAt: '2026-06-01T00:00:00Z',
});

const LEAD_A = lead('leadA', 'Acme', '+905550000001');
const LEAD_B = lead('leadB', 'Beta Ltd', '+905550000002');

const CHANNELS = [{ id: 'ch-sms', type: 'SMS', name: 'NetGSM', status: 'ACTIVE' }];

/** The national half of the PhoneInput — what the rep would actually dial. */
const phoneField = () => screen.getByPlaceholderText('5XX XXX XX XX') as HTMLInputElement;

function renderBothCached() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // BOTH leads are in the cache before the first render — that is the whole
  // premise. With lead B cached, `isLoading` is false on arrival and the page
  // never hits its early-return, so nothing below it unmounts.
  qc.setQueryData(['marketing', 'lead', 'leadA'], LEAD_A);
  qc.setQueryData(['marketing', 'lead', 'leadB'], LEAD_B);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/leads/leadA']}>
        <Link to="/leads/leadB">open-lead-b</Link>
        <Routes>
          <Route path="/leads" element={<div data-testid="leads-list" />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LeadDetailPage — the header resets per lead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLead.mockImplementation((id: string) => Promise.resolve(id === 'leadA' ? LEAD_A : LEAD_B));
    listConversations.mockResolvedValue([]);
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(url === '/channels' ? { data: CHANNELS } : { data: {} }),
    );
    apiPost.mockResolvedValue({ data: {} });
  });

  it('carries lead B’s number into Ara after navigating from a cached lead A', async () => {
    const user = userEvent.setup();
    renderBothCached();

    await screen.findByText('Acme');
    expect(phoneField()).toHaveValue('5550000001');
    // Captured BEFORE the navigation: this node lives outside the header, so
    // if the page had unmounted and remounted, the assertion below it fails and
    // the number check would have been vacuous.
    const tabBefore = screen.getByRole('tab', { name: 'Akış' });

    await user.click(screen.getByRole('link', { name: 'open-lead-b' }));

    await screen.findByText('Beta Ltd');
    expect(screen.getByRole('tab', { name: 'Akış' })).toBe(tabBefore);
    expect(phoneField()).toHaveValue('5550000002');
  });

  it('does not carry a half-typed first message onto the next lead', async () => {
    const user = userEvent.setup();
    renderBothCached();

    await screen.findByText('Acme');
    const message = screen.getByRole('button', { name: 'Mesaj' });
    await waitFor(() => expect(message).toBeEnabled());
    await user.click(message);

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/İlk mesaj/), 'Merhaba Ahmet');
    await user.click(within(dialog).getByRole('button', { name: 'İptal' }));

    await user.click(screen.getByRole('link', { name: 'open-lead-b' }));
    await screen.findByText('Beta Ltd');

    const messageB = screen.getByRole('button', { name: 'Mesaj' });
    await waitFor(() => expect(messageB).toBeEnabled());
    await user.click(messageB);

    const dialogB = await screen.findByRole('dialog');
    expect(within(dialogB).getByLabelText(/İlk mesaj/)).toHaveValue('');
  });
});
