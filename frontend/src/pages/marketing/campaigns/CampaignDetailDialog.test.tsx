import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k, i18n: { language: 'en' } }),
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
      url.endsWith('/recipients')
        ? Promise.resolve({ data: [{ id: 'r1', leadId: 'l1', status: 'SENT', sentAt: null, openedAt: null, clickedAt: null, error: null }] })
        : Promise.resolve({ data: { id: 'c1', name: 'Promo', channel: 'EMAIL', status: 'SENT', stats: { recipients: 1, sent: 1 } } }),
    );
    render(<CampaignDetailDialog campaignId="c1" onClose={vi.fn()} />, { wrapper });
    expect(await screen.findByText('l1')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/campaigns/c1');
    expect(get).toHaveBeenCalledWith('/campaigns/c1/recipients');
  });

  it('renders the NetGSM delivery row from stats.sms without crashing on the nested object', async () => {
    get.mockImplementation((url: string) =>
      url.endsWith('/recipients')
        ? Promise.resolve({ data: [] })
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
      url.endsWith('/recipients')
        ? Promise.resolve({ data: [] })
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
      url.endsWith('/recipients')
        ? Promise.resolve({ data: [] })
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
      url.endsWith('/recipients')
        ? Promise.resolve({ data: [] })
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
