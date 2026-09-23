import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EmailHealthCard from './EmailHealthCard';

const get = vi.fn();

vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: { get: (...a: unknown[]) => get(...a) },
}));
// The stand-in interpolates `{{x}}` the way i18next does — several of the
// strings this card renders carry a count, and a mock that returned the raw
// template would let a broken placeholder pass as a rendered sentence.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: Record<string, unknown> | string) => {
      const opts = typeof d === 'string' ? { defaultValue: d } : (d ?? {});
      const template = (opts.defaultValue as string) ?? k;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
        opts[name] === undefined ? `{{${name}}}` : String(opts[name]),
      );
    },
    i18n: { language: 'tr' },
  }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** The shape `GET /channels/email/health` answers. */
function report(over: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    since: '2026-09-15T00:00:00.000Z',
    until: '2026-09-22T00:00:00.000Z',
    identity: {
      transport: 'PLATFORM',
      fromEmail: 'admin@jeetagrowth.com',
      fromName: 'Acme via Jeeta',
      replyTo: 'owner@acme.com',
      degraded: { code: 'NO_MAILBOX', fix: 'CONNECT_MAILBOX' },
    },
    send: {
      total: 10,
      sent: 8,
      refused: 1,
      failedPermanent: 1,
      failedTransient: 0,
      deduped: 0,
      pending: 0,
      attempted: 9,
      bounced: 0,
      complained: 0,
      failureRate: 0.111,
      bounceRate: 0,
      complaintRate: 0,
      topReasons: [],
    },
    byClass: {},
    inbound: { total: 0, done: 0, skipped: 0, failed: 0, quarantined: 0 },
    suppression: { total: 0, byReason: {} },
    mailboxes: [],
    daily: { day: '2026-09-22', limit: 1000, used: 12, remaining: 988 },
    paused: false,
    partial: false,
    inert: [],
    ...over,
  };
}

describe('EmailHealthCard', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: report() });
  });

  it('asks the health endpoint once and names who the mail is from', async () => {
    render(<EmailHealthCard />, { wrapper });

    expect(await screen.findByText(/admin@jeetagrowth.com/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/channels/email/health');
    // The tenant's own reply address — the half of the platform-fallback
    // answer that tells them a customer's reply still reaches them.
    expect(screen.getByText(/owner@acme.com/)).toBeInTheDocument();
  });

  it('explains a degraded sender in words, never as a server code', async () => {
    render(<EmailHealthCard />, { wrapper });

    expect(await screen.findByText(/Mailiniz Jeeta üzerinden gönderiliyor/)).toBeInTheDocument();
    expect(screen.queryByText('NO_MAILBOX')).not.toBeInTheDocument();
  });

  it('renders each mailbox as two lanes, with the reason for the broken one', async () => {
    get.mockResolvedValue({
      data: report({
        mailboxes: [
          {
            channelId: 'ch-1',
            name: 'Destek',
            address: 'destek@acme.com',
            verified: true,
            sendOk: true,
            receiveOk: false,
            receiveReason: 'AUTH_FAILED',
            receiveSince: '2026-09-22T08:00:00.000Z',
            quarantined: 0,
          },
        ],
      }),
    });
    render(<EmailHealthCard />, { wrapper });

    expect(await screen.findByText('destek@acme.com')).toBeInTheDocument();
    expect(screen.getByText(/Gönderim ✓/)).toBeInTheDocument();
    expect(screen.getByText(/Alım ✗/)).toBeInTheDocument();
    expect(screen.getByText(/Kullanıcı adı veya parola kabul edilmedi/)).toBeInTheDocument();
  });

  // A lane nothing has ever reported on is UNKNOWN, not broken. Rendering an
  // absent value as ✗ is how a working mailbox ends up looking dead.
  it('does not claim a lane is broken when nothing has reported on it', async () => {
    get.mockResolvedValue({
      data: report({
        mailboxes: [
          {
            channelId: 'ch-1',
            name: 'Destek',
            address: 'destek@acme.com',
            verified: true,
            sendOk: null,
            receiveOk: null,
            quarantined: 0,
          },
        ],
      }),
    });
    render(<EmailHealthCard />, { wrapper });

    expect(await screen.findByText('destek@acme.com')).toBeInTheDocument();
    expect(screen.queryByText(/✗/)).not.toBeInTheDocument();
  });

  it('says a mailbox is unverified rather than pretending it works', async () => {
    get.mockResolvedValue({
      data: report({
        mailboxes: [
          { channelId: 'ch-1', name: 'Destek', address: 'd@acme.com', verified: false, sendOk: null, receiveOk: null, quarantined: 0 },
        ],
      }),
    });
    render(<EmailHealthCard />, { wrapper });
    expect(await screen.findByText(/henüz doğrulanmadı/)).toBeInTheDocument();
  });

  it('asks the owner to reconnect a mailbox whose consent died', async () => {
    get.mockResolvedValue({
      data: report({
        mailboxes: [
          {
            channelId: 'ch-1',
            name: 'Destek',
            address: 'd@acme.com',
            verified: true,
            sendOk: false,
            receiveOk: true,
            reauthRequiredAt: '2026-09-22T09:00:00.000Z',
            quarantined: 0,
          },
        ],
      }),
    });
    render(<EmailHealthCard />, { wrapper });
    expect(await screen.findByText(/Bağlantı yenilenmeli/)).toBeInTheDocument();
  });

  it('counts the mail that could not be taken in', async () => {
    get.mockResolvedValue({
      data: report({ inbound: { total: 9, done: 6, skipped: 0, failed: 0, quarantined: 3 } }),
    });
    render(<EmailHealthCard />, { wrapper });
    expect(await screen.findByText(/3 gelen e-posta işlenemedi/)).toBeInTheDocument();
  });

  it('shows today against the cap, and says so when it is spent', async () => {
    render(<EmailHealthCard />, { wrapper });
    expect(await screen.findByText('12 / 1000')).toBeInTheDocument();

    get.mockResolvedValue({
      data: report({ daily: { day: '2026-09-22', limit: 1000, used: 1000, remaining: 0 } }),
    });
    render(<EmailHealthCard />, { wrapper });
    expect(await screen.findByText(/Günlük e-posta sınırına ulaşıldı/)).toBeInTheDocument();
  });

  it('says plainly when an operator has paused sending', async () => {
    get.mockResolvedValue({ data: report({ paused: true }) });
    render(<EmailHealthCard />, { wrapper });
    expect(await screen.findByText(/gönderimi duraklatıldı/)).toBeInTheDocument();
  });

  // The cheapest possible answer to "why did nothing send": name the key.
  it('lists the features this deployment leaves switched off, by env key', async () => {
    get.mockResolvedValue({
      data: report({
        inert: [
          {
            key: 'MAILBOX_OAUTH_GOOGLE',
            env: ['GOOGLE_MAIL_CLIENT_ID', 'GOOGLE_MAIL_CLIENT_SECRET'],
            missing: ['GOOGLE_MAIL_CLIENT_ID'],
          },
        ],
      }),
    });
    render(<EmailHealthCard />, { wrapper });

    expect(await screen.findByText(/Google ile posta kutusu bağlama/)).toBeInTheDocument();
    expect(screen.getByText('GOOGLE_MAIL_CLIENT_ID')).toBeInTheDocument();
  });

  it('warns that the numbers understate when a read could not be answered', async () => {
    get.mockResolvedValue({ data: report({ partial: true }) });
    render(<EmailHealthCard />, { wrapper });
    expect(await screen.findByText(/bazı sayılar eksik/i)).toBeInTheDocument();
  });

  it('stays a card, not a crash, when the endpoint refuses', async () => {
    get.mockRejectedValue({ response: { status: 403 } });
    render(<EmailHealthCard />, { wrapper });
    expect(await screen.findByText(/E-posta sağlığı/)).toBeInTheDocument();
  });
});
