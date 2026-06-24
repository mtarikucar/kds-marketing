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
