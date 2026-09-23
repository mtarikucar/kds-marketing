import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SendingDomainsPage from './SendingDomainsPage';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn().mockResolvedValue({ data: {} });
const hasMock = vi.fn(() => true);
let entLoading = false;

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));
vi.mock('../../../features/marketing/hooks/useEntitlements', () => ({
  useEntitlements: () => ({ has: hasMock, isLoading: entLoading }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: { defaultValue?: string } | string) =>
      (typeof d === 'string' ? d : d?.defaultValue) ?? _k,
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

const RECORDS = [
  { label: 'DKIM', host: 'mkt1a2b._domainkey.a.example.com', type: 'TXT', value: 'v=DKIM1; k=rsa; p=PUB' },
  {
    label: 'SPF',
    host: 'a.example.com',
    type: 'TXT',
    value: 'v=spf1 include:spf.jeeta.example ~all',
    noteCode: 'SPF_MERGE',
    note: 'If a.example.com already has a v=spf1 record, do not add a second one — edit the existing record.',
  },
  {
    label: 'DMARC',
    host: '_dmarc.a.example.com',
    type: 'TXT',
    value: 'v=DMARC1; p=none',
    onlyIfAbsent: true,
    noteCode: 'DMARC_ONLY_IF_ABSENT',
    note: 'Only add this if _dmarc.a.example.com has no TXT record yet.',
  },
];

function row(over: Record<string, unknown> = {}) {
  return { id: 'd1', domain: 'a.example.com', status: 'PENDING', fromEmail: null, lastError: null, records: [], ...over };
}

describe('SendingDomainsPage', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    del.mockClear();
    hasMock.mockReset();
    hasMock.mockReturnValue(true);
    entLoading = false;
    get.mockResolvedValue({ data: [row(), row({ id: 'd2', domain: 'b.example.com' })] });
    // Verify never resolves → the mutation stays pending so we can observe which
    // row reflects the loading state.
    post.mockImplementation((url: string) =>
      url.includes('/verify') ? new Promise(() => {}) : Promise.resolve({ data: {} }),
    );
  });

  describe('per-row actions', () => {
    it('only disables the Verify button of the domain being verified, not the others', async () => {
      render(<SendingDomainsPage />, { wrapper });

      const buttons = await screen.findAllByRole('button', { name: /verify/i });
      expect(buttons).toHaveLength(2);

      await userEvent.click(buttons[0]);

      const after = screen.getAllByRole('button', { name: /verify/i });
      expect(after[0]).toBeDisabled(); // the one we clicked is loading
      expect(after[1]).not.toBeDisabled(); // the other domain stays actionable
    });

    // A sending domain is DNS-verified email infrastructure — deleting it stops
    // authenticated email from that domain (DKIM/SPF), and re-adding means redoing
    // the DNS records. The trash button must confirm, not delete on a single click.
    it('confirms before deleting a domain (no immediate delete)', async () => {
      render(<SendingDomainsPage />, { wrapper });

      const delButtons = await screen.findAllByRole('button', { name: 'Delete' });
      expect(delButtons).toHaveLength(2);

      await userEvent.click(delButtons[0]);
      expect(del).not.toHaveBeenCalled();

      const confirm = await screen.findByRole('dialog');
      await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(del).toHaveBeenCalledWith('/sending-domains/d1'));
    });
  });

  /**
   * The register endpoint answers 503 unless an operator has actually wired an
   * ESP. Offering the form anyway is how an owner spent a minute typing their
   * domain to be told "not enabled", with no hint that connecting a mailbox is
   * the route that does work on this deployment.
   */
  describe('when the feature is off on this deployment', () => {
    beforeEach(() => {
      hasMock.mockReturnValue(false);
      get.mockResolvedValue({ data: [] });
    });

    it('does not offer the form, and points at the route that does work', async () => {
      render(<SendingDomainsPage />, { wrapper });

      expect(await screen.findByTestId('sending-domains-disabled')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('mail.acme.com')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: /connect a mailbox/i })).toHaveAttribute(
        'href',
        '/accounts?focus=email',
      );
    });

    // useEntitlements fails CLOSED while GET /billing/summary is in flight, so
    // without the loading flag every owner sees "not enabled" for a moment.
    it('shows neither the form nor the disabled state while entitlements load', async () => {
      entLoading = true;
      render(<SendingDomainsPage />, { wrapper });

      await waitFor(() => expect(get).toHaveBeenCalled());
      expect(screen.queryByTestId('sending-domains-disabled')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    });

    it('still lists domains that were registered while it was on', async () => {
      get.mockResolvedValue({ data: [row()] });
      render(<SendingDomainsPage />, { wrapper });

      expect(await screen.findByText('a.example.com')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    });
  });

  describe('DNS guidance', () => {
    beforeEach(() => {
      get.mockResolvedValue({ data: [row({ records: RECORDS })] });
    });

    it('never shows SPF as a record to paste blind', async () => {
      render(<SendingDomainsPage />, { wrapper });
      expect(await screen.findByText(/do not add a second one/i)).toBeInTheDocument();
    });

    it('marks the DMARC record as conditional, not a step', async () => {
      render(<SendingDomainsPage />, { wrapper });
      await screen.findByText('v=DMARC1; p=none');
      expect(screen.getByTestId('record-DMARC')).toHaveTextContent(/only add this if/i);
      expect(screen.getByTestId('record-DMARC')).toHaveTextContent(/only if it does not exist yet/i);
    });

    it('steers the tenant to a subdomain, where there is nothing to collide with', async () => {
      render(<SendingDomainsPage />, { wrapper });
      expect(await screen.findByText(/subdomain/i)).toBeInTheDocument();
    });
  });

  /**
   * "Not yet found: SPF" is the wrong advice when the record is there twice —
   * following it makes the tenant's own mail fail SPF harder.
   */
  describe('after a verify that came back with a reason', () => {
    beforeEach(() => {
      get.mockResolvedValue({ data: [row({ records: RECORDS, lastError: 'Not yet found: SPF' })] });
      post.mockResolvedValue({
        data: row({
          records: RECORDS,
          checks: { dkim: { ok: true }, spf: { ok: false, reason: 'DUPLICATE' }, dmarc: { ok: true } },
        }),
      });
    });

    it('names the duplicate instead of telling the tenant to add the record again', async () => {
      render(<SendingDomainsPage />, { wrapper });
      await userEvent.click(await screen.findByRole('button', { name: /verify/i }));

      expect(await screen.findByText(/two v=spf1 records/i)).toBeInTheDocument();
      expect(screen.queryByText('Not yet found: SPF')).not.toBeInTheDocument();
    });

    it('says the check could not be made, rather than that a record is missing', async () => {
      post.mockResolvedValue({
        data: row({
          records: RECORDS,
          checks: { dkim: { ok: false, reason: 'UNAVAILABLE' }, spf: { ok: true }, dmarc: { ok: true } },
        }),
      });
      render(<SendingDomainsPage />, { wrapper });
      await userEvent.click(await screen.findByRole('button', { name: /verify/i }));

      expect(await screen.findByText(/could not be checked/i)).toBeInTheDocument();
    });
  });
});
