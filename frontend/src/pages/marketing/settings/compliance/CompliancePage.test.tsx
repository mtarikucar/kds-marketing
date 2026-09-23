import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CompliancePage, { ComplianceRequestsSection } from './CompliancePage';
import marketingApi from '@/features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';

/** `GET /leads` answers with the Lead row's scalars unfiltered, so the three
 *  deliverability columns ride along — which is why the chips need no new read. */
type MockLead = {
  id: string;
  businessName: string;
  contactPerson?: string;
  email?: string;
  emailOptOut?: boolean;
  emailBouncedAt?: string | null;
  emailVerifiedStatus?: string;
};

const BASE_LEAD: MockLead = {
  id: 'lead-1',
  businessName: 'Acme Co',
  contactPerson: 'Jane',
  email: 'jane@acme.test',
};

const LEADS: MockLead[] = [{ ...BASE_LEAD }];

/** What `GET /compliance/leads/:id/consent` answers — latest per type. */
const CONSENTS: { type: string; granted: boolean; at: string; source?: string | null }[] = [];

vi.mock('@/features/marketing/api/marketingApi', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/compliance/requests')
        return Promise.resolve({
          data: [
            {
              id: 'req-1',
              kind: 'ERASURE',
              status: 'PENDING',
              leadId: 'lead-1',
              requestedAt: '2026-08-01T00:00:00.000Z',
              completedAt: null,
            },
          ],
        });
      if (url === '/leads') return Promise.resolve({ data: { data: LEADS } });
      if (url.includes('/consent')) return Promise.resolve({ data: CONSENTS });
      return Promise.resolve({ data: [] });
    }),
    post: vi.fn().mockResolvedValue({ data: { id: 'req-1', kind: 'ERASURE', status: 'PENDING' } }),
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ?? (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'en' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CompliancePage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts and renders the page heading', () => {
    render(<CompliancePage />, { wrapper });
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('searches for a lead, selects it, and reveals data-subject actions', async () => {
    render(<CompliancePage />, { wrapper });
    const searchBox = screen.getByLabelText(/search leads/i);
    await userEvent.type(searchBox, 'Acme');
    // The matching lead appears as a selectable row.
    const leadRow = await screen.findByRole('button', { name: /acme co/i });
    await userEvent.click(leadRow);
    // Selecting reveals the export action.
    expect(await screen.findByRole('button', { name: /export data/i })).toBeInTheDocument();
  });
});

/**
 * The request-history half, extracted so the Studio's `?tool=ops` drawer can
 * mount it beside the webhook deliveries and the connector audit — "is a data
 * request waiting on me" is a weekly question that used to cost a trip through
 * the gear.
 *
 * Both directions are pinned: the section stands alone, AND the page still
 * renders it in its own tab. An extraction that quietly dropped the page's tab
 * would move the surface rather than add a door to it.
 */
describe('ComplianceRequestsSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads and renders the request history on its own', async () => {
    render(<ComplianceRequestsSection />, { wrapper });
    expect(await screen.findByText('Erasure')).toBeInTheDocument();
  });

  it('is still what the page shows in its Request history tab', async () => {
    render(<CompliancePage />, { wrapper });

    await userEvent.click(await screen.findByRole('tab', { name: 'Request history' }));
    expect(await screen.findByText('Erasure')).toBeInTheDocument();
  });

  it('the page drops its own header when embedded, and keeps it otherwise', async () => {
    const { unmount } = render(<CompliancePage embedded />, { wrapper });
    expect(screen.queryByRole('heading', { name: 'Compliance' })).not.toBeInTheDocument();
    unmount();

    render(<CompliancePage />, { wrapper });
    expect(await screen.findByRole('heading', { name: 'Compliance' })).toBeInTheDocument();
  });
});

/**
 * The per-person email half of the console (`optout-state-invisible`).
 *
 * This page already answered "what did they consent to and when". What it could
 * not answer was "may we mail them today, and if not why" — nor could anyone
 * change it from here, which is exactly where a written "remove me" request
 * lands when nobody has a conversation with the sender.
 */
describe('CompliancePage — email standing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    LEADS[0] = { ...BASE_LEAD };
    CONSENTS.length = 0;
    useMarketingAuthStore.setState({
      user: {
        id: 'u1',
        workspaceId: 'ws1',
        email: 'm@acme.test',
        firstName: 'M',
        lastName: 'K',
        role: 'MANAGER',
      },
      isAuthenticated: true,
    });
  });

  // The shared email-standing component carries TURKISH inline defaults, like
  // the two lead surfaces it is also mounted on (this page's own strings are the
  // older English-default convention). Both keys exist in both catalogues, so
  // the difference is visible only to this mocked `t`, which answers with the
  // default it was handed.
  async function selectLead() {
    render(<CompliancePage />, { wrapper });
    await userEvent.type(screen.getByLabelText(/search leads/i), 'Acme');
    await userEvent.click(await screen.findByRole('button', { name: /acme co/i }));
  }

  it('says the selected person unsubscribed, and dates it from the consent ledger', async () => {
    LEADS[0] = { ...BASE_LEAD, emailOptOut: true };
    CONSENTS.push({ type: 'MARKETING_EMAIL', granted: false, at: '2026-08-15T00:00:00.000Z' });

    await selectLead();

    const chip = await screen.findByTestId('email-chip-optedOut');
    expect(chip).toHaveTextContent('Abonelikten çıktı');
    expect(chip).toHaveTextContent('2026');
  });

  it('says so plainly when there is nothing standing in the way', async () => {
    LEADS[0] = { ...BASE_LEAD, emailOptOut: false, emailBouncedAt: null };

    await selectLead();

    expect(await screen.findByText('Bu kişiye e-posta gönderilebilir.')).toBeInTheDocument();
  });

  it('records a withdrawal through the endpoint that owns the ledger', async () => {
    LEADS[0] = { ...BASE_LEAD, emailOptOut: false };
    await selectLead();

    await userEvent.click(
      await screen.findByRole('button', { name: /Pazarlama e-postasından çıkar/ }),
    );

    await waitFor(() =>
      expect(marketingApi.post).toHaveBeenCalledWith('/leads/lead-1/email-suppression', {
        action: 'OPT_OUT',
      }),
    );
  });

  /**
   * §C39 asks for "date + source". A date alone cannot answer the question a
   * compliance officer is actually asked — did the person untick a form, reply
   * STOP, or did a rep do it for them — and `leads.suppression.source` shipped
   * in both catalogues with nothing rendering it.
   */
  it('shows where a consent record came from, beside its type', async () => {
    CONSENTS.push({
      type: 'MARKETING_EMAIL',
      granted: false,
      at: '2026-03-12T09:00:00.000Z',
      source: 'form:f1 :: Kampanyalardan haberdar olmak istiyorum',
    });

    await selectLead();

    expect(
      await screen.findByText(/form:f1 :: Kampanyalardan haberdar olmak istiyorum/),
    ).toBeInTheDocument();
  });

  it('renders nothing extra for a record written before sources were captured', async () => {
    CONSENTS.push({ type: 'MARKETING_EMAIL', granted: true, at: '2026-03-12T09:00:00.000Z', source: null });

    await selectLead();
    // Wait for the record itself, not the section heading — "Consent records"
    // also appears in the page subtitle.
    await screen.findByText(/^MARKETING EMAIL$/);

    expect(screen.queryByText(/^Source:/)).not.toBeInTheDocument();
  });
});
