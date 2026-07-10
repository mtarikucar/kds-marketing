import {
  netgsmWebhookToken,
  netgsmWebhookUrl,
  payloadDigest,
  verifyNetgsmWebhookToken,
} from './netgsm-webhook.util';

/**
 * NetGSM signs nothing, so the unified public receiver URL carries an
 * unguessable per-workspace-per-purpose token derived from
 * MARKETING_SECRET_KEY. Mirrors netgsm-callback.util.spec.ts for the MO
 * callback, but domain-separated ("netgsm-hub:") and keyed by purpose too.
 */
describe('netgsm webhook token', () => {
  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.from('k'.repeat(32)).toString('base64');
  });
  afterAll(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('is deterministic per workspace+purpose and verifies its own token', () => {
    const t = netgsmWebhookToken('ws-1', 'events');
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(netgsmWebhookToken('ws-1', 'events')).toBe(t);
    expect(verifyNetgsmWebhookToken('ws-1', 'events', t)).toBe(true);
  });

  it('differs across purposes for the same workspace', () => {
    const events = netgsmWebhookToken('ws-1', 'events');
    const iys = netgsmWebhookToken('ws-1', 'iys');
    const voice = netgsmWebhookToken('ws-1', 'voice-report');
    const autocall = netgsmWebhookToken('ws-1', 'autocall-report');
    expect(new Set([events, iys, voice, autocall]).size).toBe(4);
  });

  it('differs across workspaces for the same purpose', () => {
    const t1 = netgsmWebhookToken('ws-1', 'events');
    const t2 = netgsmWebhookToken('ws-2', 'events');
    expect(t1).not.toBe(t2);
    expect(verifyNetgsmWebhookToken('ws-2', 'events', t1)).toBe(false);
  });

  it('rejects a tampered, empty, or garbage token without throwing', () => {
    const t = netgsmWebhookToken('ws-1', 'events');
    const tampered = t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a');
    expect(verifyNetgsmWebhookToken('ws-1', 'events', tampered)).toBe(false);
    expect(verifyNetgsmWebhookToken('ws-1', 'events', '')).toBe(false);
    expect(verifyNetgsmWebhookToken('ws-1', 'events', 'deadbeef')).toBe(false);
  });

  it('rejects (does not throw) when the secret key is absent', () => {
    delete process.env.MARKETING_SECRET_KEY;
    expect(verifyNetgsmWebhookToken('ws-1', 'events', 'whatever')).toBe(false);
    process.env.MARKETING_SECRET_KEY = Buffer.from('k'.repeat(32)).toString('base64');
  });
});

describe('netgsmWebhookUrl', () => {
  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.from('k'.repeat(32)).toString('base64');
  });
  afterAll(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  it('embeds the workspaceId, token, and purpose in the path', () => {
    const url = netgsmWebhookUrl('https://m.example.com', 'ws-1', 'events');
    expect(url).toBe(
      `https://m.example.com/api/public/netgsm/ws-1/${netgsmWebhookToken('ws-1', 'events')}/events`,
    );
  });

  it('strips a trailing slash on the base URL', () => {
    const url = netgsmWebhookUrl('https://m.example.com/', 'ws-1', 'events');
    expect(url).not.toContain('.com//api');
  });

  it('returns null without a base URL or without the secret key', () => {
    expect(netgsmWebhookUrl('', 'ws-1', 'events')).toBeNull();
    expect(netgsmWebhookUrl(undefined, 'ws-1', 'events')).toBeNull();
    delete process.env.MARKETING_SECRET_KEY;
    expect(netgsmWebhookUrl('https://m.example.com', 'ws-1', 'events')).toBeNull();
    process.env.MARKETING_SECRET_KEY = Buffer.from('k'.repeat(32)).toString('base64');
  });
});

describe('payloadDigest', () => {
  it('is deterministic for the same body and differs for different bodies', () => {
    const a = payloadDigest({ foo: 'bar' });
    const b = payloadDigest({ foo: 'bar' });
    const c = payloadDigest({ foo: 'baz' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles null/undefined bodies without throwing', () => {
    expect(payloadDigest(undefined)).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadDigest(null)).toMatch(/^[0-9a-f]{64}$/);
  });
});
