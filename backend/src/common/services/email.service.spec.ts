// nodemailer mock — the transport options are the subject of half of these
// tests, so nothing may reach a real SMTP server.
const mockSendMail = jest.fn();
const mockVerify = jest.fn((cb?: (e: Error | null) => void) => (cb ? cb(null) : Promise.resolve(true)));
const mockCreateTransport = jest.fn((_options: any) => ({ sendMail: mockSendMail, verify: mockVerify }));
jest.mock('nodemailer', () => ({ createTransport: (options: any) => mockCreateTransport(options) }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EmailService } from './email.service';

/**
 * Iter-98 regression for EmailService template caching.
 *
 * Pre-fix `compileTemplate` did
 *
 *   const src = fs.readFileSync(templatePath, "utf-8");
 *   const template = Handlebars.compile(src);
 *   return template(context);
 *
 * on every send. Cron-driven flows (z-report nightly mailings) and
 * auth bursts (verification + password reset) all hit this hot path.
 * Iter-98 mirrors iter-97's NotificationService cache: lazy-load on
 * first use, memoize in a Map for the process lifetime, async readFile.
 * Unlike NotificationService, compileTemplate THROWS on miss (auth
 * needs to surface the error loudly), and misses are NOT cached.
 */
describe('EmailService template cache (iter-98)', () => {
  let storageRoot: string;
  let originalCwd: string;
  let templatesDir: string;

  beforeAll(() => {
    originalCwd = process.cwd();
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'email-svc-spec-'));
    templatesDir = path.join(storageRoot, 'templates', 'emails');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(templatesDir, 'iter98-test.hbs'),
      '<p>Welcome {{name}}</p>',
    );
    process.chdir(storageRoot);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  function newService(): EmailService {
    const config = {
      get: jest.fn((key: string, fallback?: any) => {
        // Force the no-transporter "mock" path so sendEmail doesn't try
        // to talk to an SMTP server. compileTemplate still runs first.
        if (key === 'EMAIL_HOST' || key === 'EMAIL_USER' || key === 'EMAIL_PASSWORD') {
          return undefined;
        }
        return fallback;
      }),
    } as any;
    return new EmailService(config);
  }

  it('reads each template file exactly once across multiple renders (cache populated)', async () => {
    const svc = newService();
    const cache: Map<string, any> = (svc as any).templateCache;
    expect(cache.size).toBe(0);

    const compile = (svc as any).compileTemplate.bind(svc);
    const out1 = await compile('iter98-test', { name: 'World' });
    const out2 = await compile('iter98-test', { name: 'Again' });

    expect(out1).toBe('<p>Welcome World</p>');
    expect(out2).toBe('<p>Welcome Again</p>');
    expect(cache.size).toBe(1);
    expect(cache.has('iter98-test')).toBe(true);
  });

  it('throws on missing template and does NOT cache the miss', async () => {
    const svc = newService();
    const compile = (svc as any).compileTemplate.bind(svc);
    await expect(compile('does-not-exist', {})).rejects.toThrow(
      /Email template does-not-exist not found or invalid/,
    );
    // Critical: missing-template state must not persist in the cache.
    // If a later deploy adds the template, the next call should pick
    // it up without a process restart.
    expect((svc as any).templateCache.has('does-not-exist')).toBe(false);
  });

  it('re-renders the cached template with different contexts', async () => {
    const svc = newService();
    const compile = (svc as any).compileTemplate.bind(svc);
    const a = await compile('iter98-test', { name: 'Alice' });
    const b = await compile('iter98-test', { name: 'Bob' });
    const c = await compile('iter98-test', { name: 'Carol' });
    expect(a).toBe('<p>Welcome Alice</p>');
    expect(b).toBe('<p>Welcome Bob</p>');
    expect(c).toBe('<p>Welcome Carol</p>');
  });

  /**
   * The platform transport's half of RFC 8058. A workspace without its own
   * verified mailbox sends its campaigns from here, so the headers have to come
   * out of these two methods as well as the channel adapter — otherwise whether
   * a client offers an Unsubscribe button depends on which transport happened
   * to carry the mail.
   */
  describe('List-Unsubscribe on the platform transport', () => {
    function withTransport() {
      const svc = newService();
      const sendMail = jest.fn().mockResolvedValue({ messageId: '<x@y>' });
      // The constructor builds a transporter from EMAIL_HOST/USER/PASSWORD,
      // which newService() deliberately leaves unset (the [EMAIL MOCK] path).
      // Standing one in is what lets these tests see the wire.
      (svc as any).transporter = { sendMail };
      return { svc, sendMail };
    }

    it('sendCampaignEmail carries the pair when given an unsubscribe URL', async () => {
      const { svc, sendMail } = withTransport();
      await svc.sendCampaignEmail('a@b.test', 'S', 'text', '<p>rich</p>', undefined, 'https://m.test/api/public/u/tok-1');
      expect(sendMail.mock.calls[0][0].headers).toEqual({
        'List-Unsubscribe': '<https://m.test/api/public/u/tok-1>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      });
    });

    it('sendPlainEmail carries it too — a plain-text campaign is still bulk', async () => {
      const { svc, sendMail } = withTransport();
      await svc.sendPlainEmail('a@b.test', 'S', 'text', undefined, 'https://m.test/api/public/u/tok-2');
      expect(sendMail.mock.calls[0][0].headers).toMatchObject({
        'List-Unsubscribe': '<https://m.test/api/public/u/tok-2>',
      });
    });

    it('omits the headers entirely on a transactional send', async () => {
      // These same methods carry password resets and status notices. Marking
      // those as list mail would invite a client to "unsubscribe" from them.
      const { svc, sendMail } = withTransport();
      await svc.sendPlainEmail('a@b.test', 'Your code', 'text');
      expect(sendMail.mock.calls[0][0]).not.toHaveProperty('headers');
    });
  });
});

/**
 * The platform transport itself: how it is built, who it refuses, and what it
 * tells the caller when a send fails.
 *
 * `email-port-string` — EMAIL_PORT arrives as a string, so `port === 465` was
 * never true and a switch to implicit TLS would have timed out every send.
 * `no-dkim` (code half) — nodemailer signs List-Unsubscribe but NOT
 * List-Unsubscribe-Post, so Gmail and Yahoo refuse one-click even once a key is
 * published, and the shipped RFC 8058 work stays inert.
 * `send-error-race` — the reason a send failed travelled through one mutable
 * field shared by every tenant; it now travels with its own send.
 * `single-recipient-check` — nothing checked that `to` was ONE address.
 */
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----';

function svcWith(env: Record<string, string | undefined>): EmailService {
  const config = {
    get: jest.fn((key: string, fallback?: any) => (key in env ? env[key] : fallback)),
  } as any;
  return new EmailService(config);
}

const CONFIGURED = {
  EMAIL_HOST: 'smtp.jeeta.test',
  EMAIL_USER: 'bot@jeetagrowth.com',
  EMAIL_PASSWORD: 'secret',
  EMAIL_FROM: 'no-reply@jeetagrowth.com',
};

function transportOptions(): any {
  return mockCreateTransport.mock.calls[0][0];
}

describe('EmailService transport configuration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('coerces EMAIL_PORT and turns on implicit TLS for 465', () => {
    svcWith({ ...CONFIGURED, EMAIL_PORT: '465' });
    expect(transportOptions()).toMatchObject({ port: 465, secure: true });
  });

  it('leaves 587 on STARTTLS', () => {
    svcWith({ ...CONFIGURED, EMAIL_PORT: '587' });
    expect(transportOptions()).toMatchObject({ port: 587, secure: false });
  });

  it('falls back to 587 when the port is unset or junk', () => {
    svcWith({ ...CONFIGURED });
    expect(transportOptions()).toMatchObject({ port: 587, secure: false });
    jest.clearAllMocks();
    svcWith({ ...CONFIGURED, EMAIL_PORT: 'not-a-port' });
    expect(transportOptions()).toMatchObject({ port: 587, secure: false });
  });

  it('honours an explicit EMAIL_SECURE in both directions', () => {
    svcWith({ ...CONFIGURED, EMAIL_PORT: '587', EMAIL_SECURE: 'true' });
    expect(transportOptions()).toMatchObject({ port: 587, secure: true });
    jest.clearAllMocks();
    svcWith({ ...CONFIGURED, EMAIL_PORT: '465', EMAIL_SECURE: 'false' });
    expect(transportOptions()).toMatchObject({ port: 465, secure: false });
  });

  it('builds no dkim option at all when the selector or the key is missing', () => {
    // Byte-identical to today's transport: an unsigned deploy must stay
    // unsigned rather than gain a half-configured signature.
    svcWith({ ...CONFIGURED, EMAIL_PORT: '587', EMAIL_DKIM_SELECTOR: 'mkt1' });
    expect(transportOptions()).toEqual({
      host: 'smtp.jeeta.test',
      port: 587,
      secure: false,
      auth: { user: 'bot@jeetagrowth.com', pass: 'secret' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  });

  it('signs at the transport when both halves are set, and signs List-Unsubscribe-Post', () => {
    svcWith({ ...CONFIGURED, EMAIL_DKIM_SELECTOR: 'mkt1', EMAIL_DKIM_PRIVATE_KEY: PEM });
    const dkim = transportOptions().dkim;
    expect(dkim).toMatchObject({
      domainName: 'jeetagrowth.com',
      keySelector: 'mkt1',
      privateKey: PEM,
    });
    // Without this override Gmail/Yahoo still refuse one-click unsubscribe.
    expect(dkim.headerFieldNames).toContain('List-Unsubscribe-Post');
    expect(dkim.headerFieldNames).toContain('From');
  });

  it('accepts the base64 key the deploy ships, and its escaped newlines', () => {
    svcWith({
      ...CONFIGURED,
      EMAIL_DKIM_SELECTOR: 'mkt1',
      EMAIL_DKIM_PRIVATE_KEY_B64: Buffer.from(PEM, 'utf8').toString('base64'),
    });
    expect(transportOptions().dkim.privateKey).toBe(PEM);
  });

  it('refuses a key that did not decode to a PEM rather than signing everything with a broken one', () => {
    svcWith({ ...CONFIGURED, EMAIL_DKIM_SELECTOR: 'mkt1', EMAIL_DKIM_PRIVATE_KEY_B64: 'this-is-not-base64-pem' });
    expect(transportOptions()).not.toHaveProperty('dkim');
  });
});

describe('EmailService single-recipient guard', () => {
  function configured() {
    const svc = svcWith({ ...CONFIGURED, EMAIL_PORT: '587' });
    return svc;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: '<sent@jeetagrowth.com>' });
  });

  it('refuses a comma list and leaves the reason where the campaign sender can read it', async () => {
    const svc = configured();
    await expect(svc.sendPlainEmail('info@acme.test, satis@acme.test', 'S', 'body')).resolves.toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
    // A bare false makes campaign-sender write a blank reason onto every row.
    expect(svc.consumeLastPlainSendError()).toMatch(/single valid address/i);
  });

  it('refuses a CR/LF recipient on the campaign sender', async () => {
    const svc = configured();
    await expect(
      svc.sendCampaignEmail('a@b.test\r\nBcc: victim@c.test', 'S', 'body'),
    ).resolves.toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('refuses on the template sender before it ever compiles the template', async () => {
    const svc = configured();
    const compile = jest.spyOn(svc as any, 'compileTemplate');
    await expect(
      svc.sendEmail({ to: 'a@b.test;c@d.test', subject: 'S', template: 'welcome', context: {} }),
    ).resolves.toBe(false);
    expect(compile).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('still refuses in mock mode — an unconfigured deploy must not claim a fan-out delivered', async () => {
    const svc = svcWith({});
    await expect(svc.sendPlainEmail('a@b.test, c@d.test', 'S', 'body')).resolves.toBe(false);
  });

  it('lets an ordinary address through', async () => {
    const svc = configured();
    await expect(svc.sendPlainEmail('alice+tag@acme.co.uk', 'S', 'body')).resolves.toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});

describe('EmailService result-returning senders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: '<sent@jeetagrowth.com>' });
  });

  it('returns the message id on success', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await expect(svc.sendPlainEmailResult('a@b.test', 'S', 'body')).resolves.toEqual({
      ok: true,
      messageId: '<sent@jeetagrowth.com>',
    });
  });

  it('returns the provider error and its SMTP code instead of a bare false', async () => {
    const svc = svcWith({ ...CONFIGURED });
    const err: any = new Error('550 5.1.1 <ghost@acme.test>: user unknown');
    err.responseCode = 550;
    mockSendMail.mockRejectedValueOnce(err);
    const r = await svc.sendCampaignEmailResult('a@b.test', 'S', 'body', '<p>rich</p>');
    expect(r).toMatchObject({ ok: false, smtpCode: 550 });
    expect(r.error).toContain('5.1.1');
  });

  it('reports ok with no message id in mock mode, exactly as the boolean senders do', async () => {
    const svc = svcWith({});
    await expect(svc.sendPlainEmailResult('a@b.test', 'S', 'body')).resolves.toEqual({ ok: true });
    await expect(svc.sendPlainEmailWithIcsResult('a@b.test', 'S', 'body', 'BEGIN:VCALENDAR')).resolves.toEqual({
      ok: true,
    });
  });

  it('keeps the old names returning a BOOLEAN — booking and workflow branch on truthiness', async () => {
    // booking.service.ts `.then(ok => { if (!ok) ... })` and
    // workflow-action.handler.ts `delivered ? 'sent' : 'NOT sent'` both compile
    // clean against an object and both become wrong. Hence the new names.
    const svc = svcWith({ ...CONFIGURED });
    mockSendMail.mockRejectedValueOnce(new Error('nope'));
    const plain = await svc.sendPlainEmail('a@b.test', 'S', 'body');
    expect(typeof plain).toBe('boolean');
    expect(plain).toBe(false);
    const campaign = await svc.sendCampaignEmail('a@b.test', 'S', 'body');
    expect(campaign).toBe(true);
  });

  it('threads the iCalendar method through so a cancellation is a cancellation', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendPlainEmailWithIcsResult('a@b.test', 'S', 'body', 'BEGIN:VCALENDAR', undefined, {
      method: 'CANCEL',
    });
    expect(mockSendMail.mock.calls[0][0].icalEvent).toMatchObject({
      method: 'CANCEL',
      content: 'BEGIN:VCALENDAR',
    });
  });

  it('defaults the iCalendar method to REQUEST', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendPlainEmailWithIcs('a@b.test', 'S', 'body', 'BEGIN:VCALENDAR');
    expect(mockSendMail.mock.calls[0][0].icalEvent).toMatchObject({ method: 'REQUEST', filename: 'invite.ics' });
  });

  it("puts the caller's Message-ID on the wire, so a DSN can be attributed", async () => {
    // The gateway mints a deterministic id, stores it on the ledger row and
    // matches bounces and Sent-folder copies on it. Without this the recipient
    // gets nodemailer's own id and the stored one matches nothing.
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendPlainEmailResult('a@b.test', 'S', 'body', undefined, undefined, '<ml-1@jeetagrowth.com>');
    expect(mockSendMail.mock.calls[0][0].messageId).toBe('<ml-1@jeetagrowth.com>');

    await svc.sendCampaignEmailResult('a@b.test', 'S', 'body', '<p>x</p>', undefined, undefined, '<ml-2@jeetagrowth.com>');
    expect(mockSendMail.mock.calls[1][0].messageId).toBe('<ml-2@jeetagrowth.com>');

    await svc.sendPlainEmailWithIcsResult('a@b.test', 'S', 'body', 'BEGIN:VCALENDAR', undefined, undefined, '<ml-3@jeetagrowth.com>');
    expect(mockSendMail.mock.calls[2][0].messageId).toBe('<ml-3@jeetagrowth.com>');
  });

  it('lets nodemailer mint the id when no caller supplied one', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendPlainEmailResult('a@b.test', 'S', 'body');
    expect(mockSendMail.mock.calls[0][0]).not.toHaveProperty('messageId');
  });
});

describe('EmailService sender identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: '<sent@jeetagrowth.com>' });
  });

  it('carries a Reply-To from the resolved identity on the three tenant senders', async () => {
    const svc = svcWith({ ...CONFIGURED });
    const from = { email: 'no-reply@jeetagrowth.com', name: 'Acme via Jeeta', replyTo: 'sales@acme.test' };
    await svc.sendPlainEmail('a@b.test', 'S', 'body', from);
    await svc.sendCampaignEmail('a@b.test', 'S', 'body', undefined, from);
    await svc.sendPlainEmailWithIcs('a@b.test', 'S', 'body', 'BEGIN:VCALENDAR', from);
    for (const call of mockSendMail.mock.calls) {
      expect(call[0].replyTo).toBe('sales@acme.test');
      expect(call[0].from).toBe('"Acme via Jeeta" <no-reply@jeetagrowth.com>');
    }
  });

  it('never puts a Reply-To on the template sender — that path carries auth mail', async () => {
    const svc = svcWith({ ...CONFIGURED });
    // sendEmail takes no identity override at all; this pins that.
    expect((svc.sendEmail as Function).length).toBe(1);
  });

  it('adds the List-Unsubscribe-Post field name to a tenant DKIM key too', async () => {
    const svc = svcWith({ ...CONFIGURED });
    await svc.sendCampaignEmail('a@b.test', 'S', 'body', undefined, {
      email: 'news@acme.test',
      dkim: { domainName: 'acme.test', keySelector: 'mkt1', privateKey: PEM },
    });
    expect(mockSendMail.mock.calls[0][0].dkim.headerFieldNames).toContain('List-Unsubscribe-Post');
  });
});
