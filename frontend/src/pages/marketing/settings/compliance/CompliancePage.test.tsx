import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CompliancePage, { ComplianceRequestsSection } from './CompliancePage';

const LEADS = [
  { id: 'lead-1', businessName: 'Acme Co', contactPerson: 'Jane', email: 'jane@acme.test' },
];

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
      if (url.includes('/consent')) return Promise.resolve({ data: [] });
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
