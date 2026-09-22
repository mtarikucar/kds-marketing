// nodemailer mock — this file is entirely about WHICH transport a send lands
// on and how it was built, so nothing may reach a real SMTP server.
const mockCreateTransport = jest.fn((options: any) => ({
  options,
  sendMail: jest.fn().mockResolvedValue({ messageId: '<x@y>' }),
  verify: jest.fn((cb?: (e: Error | null) => void) => (cb ? cb(null) : Promise.resolve(true))),
  close: jest.fn(),
}));
jest.mock('nodemailer', () => ({ createTransport: (options: any) => mockCreateTransport(options) }));

import { EmailService } from './email.service';

/**
 * `shared-godaddy-mailbox` (HIGH), the transport half.
 *
 * One un-pooled transporter carried a campaign blast, a password reset and an
 * invoice down the same connection, opening a fresh TCP + TLS + AUTH handshake
 * for every single recipient. Nodemailer's rate limiting only EXISTS on a
 * pooled transport, so the relay had no throttle at all — and pooling the
 * SHARED transporter would have been worse than nothing: a password-reset OTP
 * would queue behind a five-thousand-recipient burst.
 *
 * So there are two transports. The shared one is byte-identical to today. A
 * SECOND, pooled, rate-limited one carries bulk and nothing else.
 */
const CONFIGURED = {
  EMAIL_HOST: 'smtp.jeeta.test',
  EMAIL_USER: 'bot@jeetagrowth.com',
  EMAIL_PASSWORD: 'secret',
  EMAIL_FROM: 'no-reply@jeetagrowth.com',
};

function svcWith(env: Record<string, string | undefined> = {}): EmailService {
  const config = {
    get: jest.fn((key: string, fallback?: any) => (key in env ? env[key] : fallback)),
  } as any;
  return new EmailService(config);
}

const shared = () => mockCreateTransport.mock.results[0].value;
const pooled = () => mockCreateTransport.mock.results[1].value;
const UNSUB = 'https://m.test/api/public/ul/tok-1';

describe('EmailService — the pooled bulk transport', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds exactly one transport at boot, and it is not pooled', () => {
    svcWith({ ...CONFIGURED });
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockCreateTransport.mock.calls[0][0]).not.toHaveProperty('pool');
  });

  it('opens the pool only when bulk mail first arrives, and reuses it after that', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendCampaignEmailResult('a@b.test', 'S', 'text', '<p>r</p>', undefined, UNSUB);
    expect(mockCreateTransport).toHaveBeenCalledTimes(2);

    await svc.sendCampaignEmailResult('c@d.test', 'S', 'text', '<p>r</p>', undefined, UNSUB);
    expect(mockCreateTransport).toHaveBeenCalledTimes(2);
    expect(pooled().sendMail).toHaveBeenCalledTimes(2);
  });

  it('pools with a connection ceiling and a rate limit — pool:true alone throttles nothing', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendCampaignEmailResult('a@b.test', 'S', 'text', undefined, undefined, UNSUB);
    expect(mockCreateTransport.mock.calls[1][0]).toMatchObject({
      pool: true,
      maxConnections: 2,
      maxMessages: 100,
      rateDelta: 60_000,
      rateLimit: 60,
    });
  });

  it('inherits the shared transport\'s host, credentials, TLS and DKIM — one identity, two connections', async () => {
    const svc = svcWith({ ...CONFIGURED, EMAIL_PORT: '465' });
    await svc.sendCampaignEmailResult('a@b.test', 'S', 'text', undefined, undefined, UNSUB);
    const [base, bulk] = mockCreateTransport.mock.calls.map(([o]: [any]) => o);
    expect(bulk).toMatchObject({
      host: base.host,
      port: base.port,
      secure: base.secure,
      auth: base.auth,
    });
  });

  it('takes its ceilings from the operator when the relay allows less', async () => {
    const svc = svcWith({
      ...CONFIGURED,
      EMAIL_BULK_MAX_CONNECTIONS: '1',
      EMAIL_BULK_RATE_PER_MINUTE: '20',
    });
    await svc.sendCampaignEmailResult('a@b.test', 'S', 'text', undefined, undefined, UNSUB);
    expect(mockCreateTransport.mock.calls[1][0]).toMatchObject({ maxConnections: 1, rateLimit: 20 });
  });

  it('EMAIL_BULK_POOL=false keeps every send on the shared transport', async () => {
    const svc = svcWith({ ...CONFIGURED, EMAIL_BULK_POOL: 'false' });
    await svc.sendCampaignEmailResult('a@b.test', 'S', 'text', undefined, undefined, UNSUB);
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(shared().sendMail).toHaveBeenCalledTimes(1);
  });

  /**
   * The routing rule, and the reason it is safe: the gate matrix makes
   * `List-Unsubscribe` REQUIRED for BULK and forbidden for every other class,
   * and `MailGuardService` fails a BULK mail closed without one. So an
   * unsubscribe URL at this transport means bulk, exactly.
   */
  describe('bulk and only bulk', () => {
    it('a campaign (unsubscribe headers) goes down the pool', async () => {
      const svc = svcWith({ ...CONFIGURED });
      await svc.sendCampaignEmailResult('a@b.test', 'S', 'text', '<p>r</p>', undefined, UNSUB);
      expect(pooled().sendMail).toHaveBeenCalledTimes(1);
      expect(shared().sendMail).not.toHaveBeenCalled();
    });

    it('an HTML INVOICE does not — no unsubscribe, no pool, no queueing behind a blast', async () => {
      const svc = svcWith({ ...CONFIGURED });
      await svc.sendCampaignEmailResult('a@b.test', 'Fatura', 'text', '<p>rich</p>');
      expect(mockCreateTransport).toHaveBeenCalledTimes(1);
      expect(shared().sendMail).toHaveBeenCalledTimes(1);
    });

    it('a booking confirmation with an .ics never touches the pool', async () => {
      const svc = svcWith({ ...CONFIGURED });
      await svc.sendPlainEmailWithIcsResult('a@b.test', 'S', 'text', 'BEGIN:VCALENDAR');
      expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    });

    it('a password reset stays on the shared transport', async () => {
      const svc = svcWith({ ...CONFIGURED });
      await svc.sendPlainEmailResult('a@b.test', 'Sifirlama', 'code');
      expect(mockCreateTransport).toHaveBeenCalledTimes(1);
      expect(shared().sendMail).toHaveBeenCalledTimes(1);
    });

    it('a PLAIN-TEXT campaign is still bulk', async () => {
      const svc = svcWith({ ...CONFIGURED });
      await svc.sendPlainEmailResult('a@b.test', 'S', 'text', undefined, UNSUB);
      expect(pooled().sendMail).toHaveBeenCalledTimes(1);
    });
  });

  it('carries the unsubscribe pair, the From and the caller\'s Message-ID over the pool unchanged', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendCampaignEmailResult(
      'a@b.test',
      'S',
      'text',
      '<p>r</p>',
      { email: 'acme@jeetagrowth.com', name: 'Acme via Jeeta', replyTo: 'hi@acme.test' },
      UNSUB,
      '<mail-1@jeetagrowth.com>',
    );
    expect(pooled().sendMail.mock.calls[0][0]).toMatchObject({
      from: '"Acme via Jeeta" <acme@jeetagrowth.com>',
      replyTo: 'hi@acme.test',
      messageId: '<mail-1@jeetagrowth.com>',
      headers: {
        'List-Unsubscribe': `<${UNSUB}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  });

  it('refuses a comma list on the pooled path too — the guard is not per-transport', async () => {
    const svc = svcWith({ ...CONFIGURED });
    const r = await svc.sendCampaignEmailResult('a@b.test, c@d.test', 'S', 'text', undefined, undefined, UNSUB);
    expect(r.ok).toBe(false);
    expect(mockCreateTransport).toHaveBeenCalledTimes(1); // never even opened
  });

  it('reports a pooled failure with the provider\'s own words, like any other send', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendCampaignEmailResult('a@b.test', 'S', 'text', undefined, undefined, UNSUB);
    pooled().sendMail.mockRejectedValueOnce(
      Object.assign(new Error('450 4.2.1 Mailbox busy'), { responseCode: 450 }),
    );
    const r = await svc.sendCampaignEmailResult('c@d.test', 'S', 'text', undefined, undefined, UNSUB);
    expect(r).toMatchObject({ ok: false, error: '450 4.2.1 Mailbox busy', smtpCode: 450 });
  });

  it('an unconfigured deploy has no pool to open — mock mode is unchanged', async () => {
    const svc = svcWith({});
    const r = await svc.sendCampaignEmailResult('a@b.test', 'S', 'text', undefined, undefined, UNSUB);
    expect(r.ok).toBe(true);
    expect(mockCreateTransport).not.toHaveBeenCalled();
  });

  it('closes the pool on shutdown so its open sockets do not outlive the app', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendCampaignEmailResult('a@b.test', 'S', 'text', undefined, undefined, UNSUB);
    const p = pooled();
    await svc.onModuleDestroy();
    expect(p.close).toHaveBeenCalled();
    // A later send opens a fresh pool rather than writing to a closed one.
    await svc.sendCampaignEmailResult('c@d.test', 'S', 'text', undefined, undefined, UNSUB);
    expect(mockCreateTransport).toHaveBeenCalledTimes(3);
  });

  it('survives a transport with no close() — shutdown is not a place to throw', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendCampaignEmailResult('a@b.test', 'S', 'text', undefined, undefined, UNSUB);
    delete (pooled() as any).close;
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
  });
});
