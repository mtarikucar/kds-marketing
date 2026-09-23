import { createHmac, createSign, generateKeyPairSync } from 'crypto';
import { ESP_PROVIDERS, espVerifierStatus, getVerifier, WebhookRequest } from './index';

/**
 * Each verifier must accept a REAL signature produced by the provider's own
 * algorithm, refuse a tampered one, and — the part that keeps the platform
 * honest — stay inert (never 500, never accept) when its operator secret is
 * unset. The fixtures are signed here with the same primitives the providers
 * use, so a copy-pasted constant can never drift into passing by accident.
 */

const ENV_KEYS = [
  'ESP_FEEDBACK_SECRET',
  'MAILGUN_WEBHOOK_SIGNING_KEY',
  'SENDGRID_EVENT_PUBLIC_KEY',
  'POSTMARK_WEBHOOK_USER',
  'POSTMARK_WEBHOOK_PASSWORD',
  'POSTMARK_WEBHOOK_IPS',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const req = (rawBody: string | Buffer, headers: WebhookRequest['headers'] = {}, ip?: string): WebhookRequest => ({
  rawBody: Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody),
  headers,
  ip,
});

describe('ESP webhook verifier registry', () => {
  it('resolves every known provider by name, case-insensitively', () => {
    for (const p of ESP_PROVIDERS) {
      expect(getVerifier(p)?.provider).toBe(p);
      expect(getVerifier(p.toUpperCase())?.provider).toBe(p);
    }
  });

  it('refuses an unknown provider rather than falling back to one', () => {
    expect(getVerifier('brevo')).toBeNull();
    expect(getVerifier('')).toBeNull();
    expect(getVerifier('../generic')).toBeNull();
  });

  it('names the missing env key per provider so the UI can say what is unset', () => {
    const status = espVerifierStatus();
    expect(status.map((s) => s.provider).sort()).toEqual([...ESP_PROVIDERS].sort());
    expect(status.every((s) => s.configured === false)).toBe(true);
    expect(status.find((s) => s.provider === 'sendgrid')?.requires).toContain('SENDGRID_EVENT_PUBLIC_KEY');
    expect(status.find((s) => s.provider === 'postmark')?.requires).toEqual([
      'POSTMARK_WEBHOOK_USER',
      'POSTMARK_WEBHOOK_PASSWORD',
    ]);

    process.env.MAILGUN_WEBHOOK_SIGNING_KEY = 'key-123';
    expect(espVerifierStatus().find((s) => s.provider === 'mailgun')?.configured).toBe(true);
  });

  it('answers from an explicit env bag without touching process.env', () => {
    const status = espVerifierStatus({ SENDGRID_EVENT_PUBLIC_KEY: 'spki' });
    expect(status.find((s) => s.provider === 'sendgrid')).toMatchObject({
      configured: true,
      missing: [],
    });
    expect(status.find((s) => s.provider === 'postmark')?.missing).toEqual([
      'POSTMARK_WEBHOOK_USER',
      'POSTMARK_WEBHOOK_PASSWORD',
    ]);
    expect(process.env.SENDGRID_EVENT_PUBLIC_KEY).toBeUndefined();
  });

  /**
   * `requires` is what the deploy guard forwards and what the health panel
   * prints. If it ever names a different set than the verifier's own gate
   * actually reads, an operator sets every key the UI asked for and the route
   * still 401s — the failure this registry exists to end, one layer over.
   */
  it('keeps `requires` in step with each verifier own gate', () => {
    for (const p of ESP_PROVIDERS) {
      const v = getVerifier(p)!;
      expect(v.requires.length).toBeGreaterThan(0);
      expect(v.configured()).toBe(false);
      // Set every key but the last: the gate must still be shut.
      for (const k of v.requires.slice(0, -1)) process.env[k] = 'value';
      expect(v.configured()).toBe(false);
      process.env[v.requires[v.requires.length - 1]] = 'value';
      expect(v.configured()).toBe(true);
      expect(espVerifierStatus().find((s) => s.provider === p)?.configured).toBe(true);
      for (const k of v.requires) delete process.env[k];
    }
  });
});

describe('generic HMAC verifier (the self-hosted relay)', () => {
  const SECRET = 'esp-secret';
  const body = '[{"email":"a@b.com","type":"bounce"}]';
  const sign = (raw: string) => createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('hex');
  const v = () => getVerifier('generic')!;

  it('accepts the raw-body HMAC and the Stripe-style t=..,s=.. spelling', () => {
    process.env.ESP_FEEDBACK_SECRET = SECRET;
    expect(v().verify(req(body, { 'x-esp-signature': sign(body) }))).toEqual({ ok: true });
    expect(v().verify(req(body, { 'x-esp-signature': `t=123,s=${sign(body)}` }))).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    process.env.ESP_FEEDBACK_SECRET = SECRET;
    const sig = sign(body);
    const tampered = body.replace('a@b.com', 'victim@b.com');
    expect(v().verify(req(tampered, { 'x-esp-signature': sig })).ok).toBe(false);
  });

  it('is inert — not broken — without ESP_FEEDBACK_SECRET', () => {
    const out = v().verify(req(body, { 'x-esp-signature': sign(body) }));
    expect(out).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    expect(v().configured()).toBe(false);
  });

  it('never throws on a missing or malformed header', () => {
    process.env.ESP_FEEDBACK_SECRET = SECRET;
    expect(v().verify(req(body, {})).ok).toBe(false);
    expect(v().verify(req(body, { 'x-esp-signature': ['a', 'b'] })).ok).toBe(false);
    expect(v().verify(req(body, { 'x-esp-signature': 's=' })).ok).toBe(false);
  });
});

describe('Mailgun verifier (timestamp + token HMAC, signature in the BODY)', () => {
  const KEY = 'mailgun-signing-key';
  const v = () => getVerifier('mailgun')!;
  const payload = (timestamp: string, token = 'a'.repeat(50), signature?: string) =>
    JSON.stringify({
      signature: {
        timestamp,
        token,
        signature: signature ?? createHmac('sha256', KEY).update(timestamp + token).digest('hex'),
      },
      'event-data': { event: 'failed', severity: 'permanent', recipient: 'dead@x.com' },
    });

  it('accepts a real Mailgun signature block, and hands back the token to spend', () => {
    process.env.MAILGUN_WEBHOOK_SIGNING_KEY = KEY;
    const ts = String(Math.floor(Date.now() / 1000));
    // The body is NOT signed here, so the token is the only thing that tells
    // one accepted request from another — the caller spends it through
    // `WebhookReplayStore` before acting on what it authenticates.
    expect(v().verify(req(payload(ts)))).toEqual({ ok: true, replayToken: 'a'.repeat(50) });
  });

  it('rejects a tampered signature', () => {
    process.env.MAILGUN_WEBHOOK_SIGNING_KEY = KEY;
    const ts = String(Math.floor(Date.now() / 1000));
    expect(v().verify(req(payload(ts, 'a'.repeat(50), 'deadbeef'))).ok).toBe(false);
  });

  it('rejects a signature minted for a different token', () => {
    process.env.MAILGUN_WEBHOOK_SIGNING_KEY = KEY;
    const ts = String(Math.floor(Date.now() / 1000));
    const good = JSON.parse(payload(ts));
    good.signature.token = 'b'.repeat(50); // re-used signature, new token
    expect(v().verify(req(JSON.stringify(good))).ok).toBe(false);
  });

  it('rejects a stale timestamp (replay) but still accepts a same-day redelivery', () => {
    process.env.MAILGUN_WEBHOOK_SIGNING_KEY = KEY;
    const old = String(Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60);
    expect(v().verify(req(payload(old)))).toEqual({ ok: false, reason: 'STALE_TIMESTAMP' });
    const retried = String(Math.floor(Date.now() / 1000) - 6 * 60 * 60);
    expect(v().verify(req(payload(retried))).ok).toBe(true);
  });

  it('is inert without the signing key, and never throws on a malformed body', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(v().verify(req(payload(ts)))).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    process.env.MAILGUN_WEBHOOK_SIGNING_KEY = KEY;
    expect(v().verify(req('not json'))).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(v().verify(req('{}'))).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('SendGrid verifier (ECDSA P-256 over timestamp + raw body)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const PUBLIC_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const v = () => getVerifier('sendgrid')!;
  const body = '[{"email":"dead@x.com","event":"bounce"}]';
  const sign = (timestamp: string, raw: string) => {
    const s = createSign('sha256');
    s.update(Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(raw)]));
    s.end();
    return s.sign(privateKey).toString('base64');
  };
  const headers = (timestamp: string, signature: string) => ({
    'x-twilio-email-event-webhook-timestamp': timestamp,
    'x-twilio-email-event-webhook-signature': signature,
  });

  it('accepts a real signed payload', () => {
    process.env.SENDGRID_EVENT_PUBLIC_KEY = PUBLIC_B64;
    const ts = String(Math.floor(Date.now() / 1000));
    expect(v().verify(req(body, headers(ts, sign(ts, body))))).toEqual({ ok: true });
  });

  it('rejects a tampered body and a swapped timestamp', () => {
    process.env.SENDGRID_EVENT_PUBLIC_KEY = PUBLIC_B64;
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(ts, body);
    expect(v().verify(req(body.replace('dead', 'live'), headers(ts, sig))).ok).toBe(false);
    expect(v().verify(req(body, headers(String(Number(ts) - 30), sig))).ok).toBe(false);
  });

  it('is inert without the public key and never throws on garbage material', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(v().verify(req(body, headers(ts, sign(ts, body))))).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    process.env.SENDGRID_EVENT_PUBLIC_KEY = 'not-a-key';
    expect(v().verify(req(body, headers(ts, sign(ts, body)))).ok).toBe(false);
    process.env.SENDGRID_EVENT_PUBLIC_KEY = PUBLIC_B64;
    expect(v().verify(req(body, headers(ts, '!!!not base64!!!'))).ok).toBe(false);
    expect(v().verify(req(body, {})).ok).toBe(false);
  });
});

describe('Postmark verifier (basic auth, optional IP allow-list)', () => {
  const v = () => getVerifier('postmark')!;
  const basic = (user: string, pass: string) => ({
    authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
  });
  const body = '{"RecordType":"SpamComplaint","Email":"pm@x.com"}';

  it('accepts the configured credentials and rejects wrong ones', () => {
    process.env.POSTMARK_WEBHOOK_USER = 'jeeta';
    process.env.POSTMARK_WEBHOOK_PASSWORD = 'hunter2';
    expect(v().verify(req(body, basic('jeeta', 'hunter2')))).toEqual({ ok: true });
    expect(v().verify(req(body, basic('jeeta', 'hunter3'))).ok).toBe(false);
    expect(v().verify(req(body, basic('other', 'hunter2'))).ok).toBe(false);
    expect(v().verify(req(body, { authorization: 'Bearer hunter2' })).ok).toBe(false);
    expect(v().verify(req(body, {})).ok).toBe(false);
  });

  it('is inert unless BOTH credentials are set', () => {
    expect(v().verify(req(body, basic('jeeta', 'hunter2')))).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    process.env.POSTMARK_WEBHOOK_USER = 'jeeta';
    expect(v().verify(req(body, basic('jeeta', '')))).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
  });

  it('enforces the IP allow-list only when one is configured', () => {
    process.env.POSTMARK_WEBHOOK_USER = 'jeeta';
    process.env.POSTMARK_WEBHOOK_PASSWORD = 'hunter2';
    expect(v().verify(req(body, basic('jeeta', 'hunter2'), '9.9.9.9'))).toEqual({ ok: true });
    process.env.POSTMARK_WEBHOOK_IPS = '3.134.147.250, 50.31.156.6';
    expect(v().verify(req(body, basic('jeeta', 'hunter2'), '9.9.9.9')).ok).toBe(false);
    expect(v().verify(req(body, basic('jeeta', 'hunter2'), '50.31.156.6'))).toEqual({ ok: true });
    // An IPv4-mapped IPv6 peer address still matches its plain form.
    expect(v().verify(req(body, basic('jeeta', 'hunter2'), '::ffff:50.31.156.6'))).toEqual({ ok: true });
  });
});
