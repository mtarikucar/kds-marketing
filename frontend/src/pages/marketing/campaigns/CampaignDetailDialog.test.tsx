import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const get = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => get(...a) },
}));
const provisionSocialFromCampaign = vi.fn();
vi.mock('../../../features/marketing/api/social-link.service', () => ({
  provisionSocialFromCampaign: (...a: unknown[]) => provisionSocialFromCampaign(...a),
}));
const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});
// Interpolates `{{var}}` the way i18next does, so a count in the copy can be
// asserted on instead of the raw placeholder.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      const raw = (typeof opts === 'string' ? opts : (opts?.defaultValue as string)) ?? key;
      if (!opts || typeof opts === 'string') return raw;
      return raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampaignDetailDialog } from './CampaignDetailDialog';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CampaignDetailDialog', () => {
  beforeEach(() => { get.mockReset(); provisionSocialFromCampaign.mockReset(); navigate.mockReset(); });

  it('loads stats and recipients for the campaign', async () => {
    get.mockImplementation((url: string) =>
      url.includes('/recipients')
        ? Promise.resolve({
            data: {
              rows: [{
                id: 'r1', leadId: 'l1', status: 'SENT', sentAt: '2026-09-01T10:00:00Z',
                openedAt: null, clickedAt: null, error: null,
                lead: { id: 'l1', contactPerson: 'Ayşe Yılmaz', businessName: 'Acme', email: 'ayse@acme.test' },
              }],
              total: 1,
            },
          })
        : Promise.resolve({ data: { id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'SENT', stats: { recipients: 1, sent: 1 } } }),
    );
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });

    // The person, not the id — and their address under it.
    expect(await screen.findByText('Ayşe Yılmaz')).toBeInTheDocument();
    expect(screen.getByText('ayse@acme.test')).toBeInTheDocument();
    expect(screen.queryByText('l1')).not.toBeInTheDocument();
    // The id stays reachable for a support thread, as the link's title.
    expect(screen.getByRole('link', { name: 'Ayşe Yılmaz' })).toHaveAttribute('title', 'l1');
    expect(get).toHaveBeenCalledWith('/campaigns/c1');
    expect(get).toHaveBeenCalledWith('/campaigns/c1/recipients?take=50&skip=0');
  });

  it('renders the NetGSM delivery row from stats.sms without crashing on the nested object', async () => {
    get.mockImplementation((url: string) =>
      url.includes('/recipients')
        ? Promise.resolve({ data: { rows: [], total: 0 } })
        : Promise.resolve({
            data: {
              id: 'c1',
              name: 'SMS Blast',
              channel: 'SMS',
              status: 'SENT',
              stats: {
                recipients: 12,
                sent: 12,
                sms: {
                  delivered: 8,
                  undelivered: 1,
                  blacklist: 1,
                  iysNotValid: 1,
                  repeated: 1, // unknown status — rolls into "other"
                  jobs: { 'job-1': { delivered: 8, undelivered: 1, blacklist: 1, iysNotValid: 1, repeated: 1 } },
                },
              },
            },
          }),
    );
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
    await screen.findByText('SMS Blast');
    expect(screen.getByText('Delivery (NetGSM):')).toBeInTheDocument();
    expect(screen.getByText('delivered: 8')).toBeInTheDocument();
    expect(screen.getByText('undelivered: 1')).toBeInTheDocument();
    expect(screen.getByText('blacklist: 1')).toBeInTheDocument();
    expect(screen.getByText('no İYS consent: 1')).toBeInTheDocument();
    // `repeated` isn't one of the known buckets — it must roll into "other", not vanish.
    expect(screen.getByText('other: 1')).toBeInTheDocument();
    // The plain-number stats badges still render normally alongside it.
    expect(screen.getByText('recipients: 12')).toBeInTheDocument();
    // And `sms` itself must never be rendered as a bare "sms: [object Object]" badge.
    expect(screen.queryByText(/sms:/i)).not.toBeInTheDocument();
  });

  // NetGSM Phase 2 Task 6 (M1 fix): surface stats.iysBlocked/iysUnavailable
  // as their own dedicated, translated badges — not the raw generic
  // "iysBlocked: 3" key/value pair, and not silently dropped (iysUnavailable
  // is a boolean, which the generic numeric-only badge loop skips).
  it('shows a dedicated İYS blocked badge and never the raw generic one', async () => {
    get.mockImplementation((url: string) =>
      url.includes('/recipients')
        ? Promise.resolve({ data: { rows: [], total: 0 } })
        : Promise.resolve({
            data: { id: 'c1', name: 'TICARI Blast', channel: 'SMS', status: 'SENDING', stats: { recipients: 10, sent: 7, iysBlocked: 3 } },
          }),
    );
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
    await screen.findByText('TICARI Blast');
    expect(screen.getByText('İYS engelli: 3')).toBeInTheDocument();
    expect(screen.queryByText('iysBlocked: 3')).not.toBeInTheDocument();
  });

  it('shows an İYS unreachable warning when stats.iysUnavailable is stamped', async () => {
    get.mockImplementation((url: string) =>
      url.includes('/recipients')
        ? Promise.resolve({ data: { rows: [], total: 0 } })
        : Promise.resolve({
            data: { id: 'c1', name: 'Stuck Blast', channel: 'SMS', status: 'SENDING', stats: { recipients: 10, sent: 0, iysUnavailable: true } },
          }),
    );
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
    await screen.findByText('Stuck Blast');
    expect(screen.getByText('İYS erişilemedi')).toBeInTheDocument();
  });

  it('provisions a social campaign from this blast via the prefill endpoint and navigates to it', async () => {
    get.mockImplementation((url: string) =>
      url.includes('/recipients')
        ? Promise.resolve({ data: { rows: [], total: 0 } })
        : Promise.resolve({ data: { id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'SENT', stats: {} } }),
    );
    provisionSocialFromCampaign.mockResolvedValue({ socialCampaignId: 'sc-new' });
    const user = userEvent.setup();
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
    await screen.findByText('Promo');
    await user.click(screen.getByRole('button', { name: 'Create social content' }));
    // Uses the dedicated provision endpoint (which prefills audience/leads/brief
    // from the blast) — NOT a bare createSocialCampaign with an empty brief.
    expect(provisionSocialFromCampaign).toHaveBeenCalledTimes(1);
    expect(provisionSocialFromCampaign).toHaveBeenCalledWith('c1');
    expect(navigate).toHaveBeenCalledWith('/social-campaigns/sc-new');
  });
});

// campaign-results-unreadable: the results panel has to be readable and
// followable — a name, a localised status, real timestamps, the failure reason,
// and an honest answer when a number was never measured.
describe('CampaignDetailDialog — readable results', () => {
  const EMAIL_CAMPAIGN = {
    id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'SENT',
    bodyHtml: '<p>hi</p>', stats: { recipients: 3, sent: 2, failed: 1, opened: 0 },
  };

  function mockApi(page: any, campaign: any = EMAIL_CAMPAIGN) {
    get.mockImplementation((url: string) =>
      url.includes('/recipients')
        ? Promise.resolve({ data: typeof page === 'function' ? page(url) : page })
        : Promise.resolve({ data: campaign }),
    );
  }

  beforeEach(() => { get.mockReset(); provisionSocialFromCampaign.mockReset(); navigate.mockReset(); });

  it('shows why a recipient was not sent to, instead of a bare enum', async () => {
    mockApi({
      rows: [{
        id: 'r1', leadId: 'l1', status: 'FAILED', sentAt: null, openedAt: null, clickedAt: null,
        error: 'mailbox unavailable',
        lead: { id: 'l1', contactPerson: 'Mehmet', businessName: 'Beta', email: 'm@beta.test' },
      }],
      total: 1,
    });
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });

    expect(await screen.findByText('Mehmet')).toBeInTheDocument();
    // The status goes through `campaigns.recipientStatus.*` — the catalogue
    // (asserted in i18n/email.i18n.test.ts) turns it into "Başarısız"/"Failed";
    // this mock renders the inline fallback, which is the raw code.
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(screen.getByText('mailbox unavailable')).toBeInTheDocument();
  });

  // A lead with no name at all must still be a row somebody can click.
  it('falls back to the business name and says when there is no address', async () => {
    mockApi({
      rows: [{
        id: 'r1', leadId: 'l1', status: 'SENT', sentAt: null, openedAt: null, clickedAt: null, error: null,
        lead: { id: 'l1', contactPerson: '', businessName: 'Acme', email: null },
      }],
      total: 1,
    });
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });

    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('no email address')).toBeInTheDocument();
  });

  it('says how many of how many, and loads the next page on demand', async () => {
    const user = userEvent.setup();
    const row = (i: number) => ({
      id: `r${i}`, leadId: `l${i}`, status: 'SENT', sentAt: null, openedAt: null, clickedAt: null,
      error: null, lead: { id: `l${i}`, contactPerson: `Kişi ${i}`, businessName: 'Acme', email: `k${i}@a.test` },
    });
    mockApi((url: string) => ({
      rows: url.includes('skip=50') ? [row(51)] : Array.from({ length: 50 }, (_, i) => row(i + 1)),
      total: 51,
    }));
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });

    expect(await screen.findByText('50 of 51 recipients')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('51 of 51 recipients')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/campaigns/c1/recipients?take=50&skip=50');
  });

  /**
   * The open pixel lives in the HTML part. A plain-text campaign has none, so
   * every "0 opened" it ever printed was a measurement nobody made — which
   * reads as "nobody opened it" and is the exact false signal this fixes.
   */
  it('never claims zero opens for a campaign that cannot measure them', async () => {
    mockApi(
      {
        rows: [{
          id: 'r1', leadId: 'l1', status: 'SENT', sentAt: '2026-09-01T10:00:00Z',
          openedAt: null, clickedAt: null, error: null,
          lead: { id: 'l1', contactPerson: 'Ayşe', businessName: 'Acme', email: 'a@x.io' },
        }],
        total: 1,
      },
      { ...EMAIL_CAMPAIGN, bodyHtml: null },
    );
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });

    await screen.findByText('Ayşe');
    expect(screen.getByText('opened: —')).toBeInTheDocument();
    expect(screen.queryByText('opened: 0')).not.toBeInTheDocument();
  });

  it('keeps the measured zero when the campaign does carry HTML', async () => {
    mockApi({ rows: [], total: 0 });
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
    expect(await screen.findByText('opened: 0')).toBeInTheDocument();
  });

  it('asks the server for one status when the filter is set', async () => {
    const user = userEvent.setup();
    mockApi({ rows: [], total: 0 });
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });

    await screen.findByText('No recipients match this filter.');
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'FAILED' }));

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/campaigns/c1/recipients?take=50&skip=0&status=FAILED'),
    );
  });

  /**
   * A campaign that stopped part-way looks IDENTICAL to one that finished
   * early: half sent, the rest PENDING, status PAUSED. The runner writes the
   * reason into the stats blob for ops; the tenant needs the sentence and the
   * button, and must never be shown the raw provider error (PLAN G8).
   */
  describe('a stalled send says so', () => {
    const withCampaign = (over: Record<string, unknown>) =>
      get.mockImplementation((url: string) =>
        url.includes('/recipients')
          ? Promise.resolve({ data: { rows: [], total: 0 } })
          : Promise.resolve({
              data: { id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'PAUSED', ...over },
            }),
      );

    it('explains the pause without printing the server error', async () => {
      withCampaign({
        stats: {
          sent: 120,
          stalledAt: '2026-09-20T10:00:00.000Z',
          stalledError: 'ECONNREFUSED smtp.acme.test:587',
        },
      });
      render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });

      expect(await screen.findByText(/Sending stopped\./)).toBeInTheDocument();
      expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
      expect(screen.queryByText(/stalledError/)).not.toBeInTheDocument();
    });

    it('says nothing on a campaign that never stalled', async () => {
      withCampaign({ stats: { sent: 120 } });
      render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
      await screen.findByText('Promo');
      expect(screen.queryByText(/Sending stopped\./)).not.toBeInTheDocument();
    });
  });
});
