// ── safeFetch mock (same seam ads-clients.spec.ts uses) ─────────────────────
const mockSafeFetch = jest.fn();
jest.mock('./safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { createHmac } from 'node:crypto';
import {
  appSecretProof,
  classifyMetaError,
  graphApiVersion,
  graphBaseUrl,
  isMetaAuthError,
  metaGraphFetch,
  metaGraphFollow,
  metaWebhookSubscription,
} from './meta-graph.util';

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

const ORIG = { ...process.env };
beforeEach(() => {
  mockSafeFetch.mockReset();
  process.env = { ...ORIG };
});
afterAll(() => {
  process.env = ORIG;
});

describe('graphApiVersion / graphBaseUrl', () => {
  it('defaults to v19.0 when unset', () => {
    delete process.env.GRAPH_API_VERSION;
    expect(graphApiVersion()).toBe('v19.0');
    expect(graphBaseUrl()).toBe('https://graph.facebook.com/v19.0');
  });
  it('reflects a valid override', () => {
    process.env.GRAPH_API_VERSION = 'v23.0';
    expect(graphApiVersion()).toBe('v23.0');
    expect(graphBaseUrl()).toBe('https://graph.facebook.com/v23.0');
  });
  it('falls back to default on a malformed value', () => {
    process.env.GRAPH_API_VERSION = 'garbage';
    expect(graphApiVersion()).toBe('v19.0');
  });
});

describe('appSecretProof', () => {
  it('is the deterministic lowercase-hex HMAC-SHA256 of the token under META_APP_SECRET', () => {
    process.env.META_APP_SECRET = 'topsecret';
    const expected = createHmac('sha256', 'topsecret').update('AbcToken').digest('hex');
    expect(appSecretProof('AbcToken')).toBe(expected);
  });
  it('differs per token', () => {
    process.env.META_APP_SECRET = 'topsecret';
    expect(appSecretProof('a')).not.toBe(appSecretProof('b'));
  });
  it('returns null (no throw) when META_APP_SECRET is unset', () => {
    delete process.env.META_APP_SECRET;
    expect(appSecretProof('AbcToken')).toBeNull();
  });
  it('returns null when the token is empty', () => {
    process.env.META_APP_SECRET = 'topsecret';
    expect(appSecretProof('')).toBeNull();
  });
});

describe('classifyMetaError / isMetaAuthError', () => {
  it('flags Graph code 190 as an auth error', () => {
    const e = classifyMetaError(400, { error: { code: 190, message: 'expired', type: 'OAuthException' } });
    expect(e.isAuthError).toBe(true);
    expect(e.code).toBe(190);
  });
  it('flags HTTP 401 as an auth error', () => {
    expect(classifyMetaError(401, {}).isAuthError).toBe(true);
  });
  it('flags an auth subcode (463) as an auth error', () => {
    expect(classifyMetaError(400, { error: { code: 200, error_subcode: 463 } }).isAuthError).toBe(true);
  });
  it('does NOT flag a plain 400 param error', () => {
    const e = classifyMetaError(400, { error: { code: 100, message: 'bad param' } });
    expect(e.isAuthError).toBe(false);
  });
  it('isMetaAuthError reads a thrown Error flag and a failed result', () => {
    const err: any = new Error('x');
    err.isAuthError = true;
    expect(isMetaAuthError(err)).toBe(true);
    expect(isMetaAuthError({ ok: false, error: { isAuthError: true } })).toBe(true);
    expect(isMetaAuthError(new Error('plain'))).toBe(false);
    expect(isMetaAuthError(null)).toBe(false);
  });
});

describe('metaGraphFetch', () => {
  it('appends access_token + appsecret_proof to the query and returns data on 200', async () => {
    process.env.META_APP_SECRET = 'topsecret';
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: 'page1' }));
    const r = await metaGraphFetch('/me', { accessToken: 'tok', query: { fields: 'id' } });
    expect(r).toEqual({ ok: true, status: 200, data: { id: 'page1' }, error: null });
    const url = mockSafeFetch.mock.calls[0][0] as string;
    expect(url).toContain('https://graph.facebook.com/v19.0/me');
    expect(url).toContain('access_token=tok');
    expect(url).toContain('fields=id');
    expect(url).toContain(`appsecret_proof=${createHmac('sha256', 'topsecret').update('tok').digest('hex')}`);
  });
  it('omits appsecret_proof (no throw) when META_APP_SECRET is unset', async () => {
    delete process.env.META_APP_SECRET;
    mockSafeFetch.mockResolvedValue(res(true, 200, {}));
    await metaGraphFetch('/me', { accessToken: 'tok' });
    expect(mockSafeFetch.mock.calls[0][0]).not.toContain('appsecret_proof');
  });
  it('uses Bearer auth (no access_token in query) when bearer:true but still adds proof', async () => {
    process.env.META_APP_SECRET = 'topsecret';
    mockSafeFetch.mockResolvedValue(res(true, 200, { messages: [{ id: 'wamid' }] }));
    await metaGraphFetch('/123/messages', { accessToken: 'tok', method: 'POST', body: { x: 1 }, bearer: true });
    const [url, init] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).not.toContain('access_token=');
    expect(url).toContain('appsecret_proof=');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ x: 1 }));
  });
  it('returns a classified error on a non-2xx response', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 400, { error: { code: 190, message: 'bad token', type: 'OAuthException' } }));
    const r = await metaGraphFetch('/me', { accessToken: 'tok' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error.isAuthError).toBe(true);
      expect(r.error.message).toBe('bad token');
    }
  });
});

describe('metaGraphFollow', () => {
  it('overwrites appsecret_proof on a provider-issued next URL', async () => {
    process.env.META_APP_SECRET = 'topsecret';
    mockSafeFetch.mockResolvedValue(res(true, 200, { data: [] }));
    await metaGraphFollow(
      'https://graph.facebook.com/v19.0/act_42/insights?after=CURSOR2&access_token=tok&appsecret_proof=STALE',
      'tok',
    );
    const url = mockSafeFetch.mock.calls[0][0] as string;
    expect(url).toContain('after=CURSOR2');
    expect(url).not.toContain('appsecret_proof=STALE');
    expect(url).toContain(`appsecret_proof=${createHmac('sha256', 'topsecret').update('tok').digest('hex')}`);
  });
});

/**
 * Whether anyone is actually listening.
 *
 * A live token and a delivering webhook are independent facts, and only the
 * first one was ever checked: Embedded Signup subscribes the app in a separate
 * best-effort call, so a channel could hold a valid token, pass verify, sit
 * ACTIVE and never receive one inbound message for as long as it existed.
 *
 * The three-valued return is the whole point. `false` is Meta answering no;
 * `null` is the probe not answering at all — a permission the token lacks, a
 * transport failure, or a node that has no such edge (asking an Instagram
 * account for subscribed_apps returns "(#100) Tried accessing nonexisting
 * field"). An unanswered probe must never be allowed to condemn a channel that
 * is working, so callers may only fail on an explicit `false`.
 */
describe('metaWebhookSubscription', () => {
  const APP = 'app1';
  const prev = process.env.META_APP_ID;
  afterEach(() => {
    if (prev === undefined) delete process.env.META_APP_ID;
    else process.env.META_APP_ID = prev;
  });

  it('true when our app is there with the messages field', async () => {
    process.env.META_APP_ID = APP;
    mockSafeFetch.mockResolvedValue(
      res(true, 200, { data: [{ id: APP, subscribed_fields: ['messages', 'message_reads'] }] }),
    );

    const out = await metaWebhookSubscription('tok', 'page1');

    expect(out.subscribed).toBe(true);
    expect(out.fields).toEqual(['messages', 'message_reads']);
  });

  it('false when the list is empty — unambiguous, app id or not', async () => {
    delete process.env.META_APP_ID;
    mockSafeFetch.mockResolvedValue(res(true, 200, { data: [] }));

    expect((await metaWebhookSubscription('tok', 'page1')).subscribed).toBe(false);
  });

  it('false when only someone else is subscribed', async () => {
    process.env.META_APP_ID = APP;
    mockSafeFetch.mockResolvedValue(
      res(true, 200, { data: [{ id: 'other-app', subscribed_fields: ['messages'] }] }),
    );

    expect((await metaWebhookSubscription('tok', 'page1')).subscribed).toBe(false);
  });

  it('false when our app is subscribed to other fields but not messages', async () => {
    process.env.META_APP_ID = APP;
    mockSafeFetch.mockResolvedValue(
      res(true, 200, { data: [{ id: APP, subscribed_fields: ['feed', 'mention'] }] }),
    );

    // Subscribed to the node, deaf to messages. Same outcome for the customer.
    expect((await metaWebhookSubscription('tok', 'page1')).subscribed).toBe(false);
  });

  it('null, never false, when the probe itself fails', async () => {
    process.env.META_APP_ID = APP;
    mockSafeFetch.mockResolvedValue(
      res(false, 400, { error: { message: '(#100) Tried accessing nonexisting field (subscribed_apps)' } }),
    );

    const out = await metaWebhookSubscription('tok', 'ig-account-id');

    expect(out.subscribed).toBeNull();
    expect(out.error).toContain('nonexisting field');
  });

  it('null when the payload has no data array at all', async () => {
    process.env.META_APP_ID = APP;
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: 'p', name: 'Page' }));

    // A 200 whose body is not the subscribed_apps shape is not evidence that
    // nothing is subscribed — treating it as `false` would condemn on a
    // misdirected call, which is how the Instagram probe would have failed.
    expect((await metaWebhookSubscription('tok', 'page1')).subscribed).toBeNull();
  });

  it('without META_APP_ID, answers only whether ANYTHING listens for messages', async () => {
    delete process.env.META_APP_ID;
    mockSafeFetch.mockResolvedValue(
      res(true, 200, { data: [{ id: 'whoever', subscribed_fields: ['messages'] }] }),
    );

    expect((await metaWebhookSubscription('tok', 'page1')).subscribed).toBe(true);
  });
});
