// ── safeFetch mock ──────────────────────────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { NetasistanClient } from './netasistan.client';
import { AccountRateBudgeter } from '../core/account-rate-budgeter';

function res(status: number, body: unknown) {
  return { status, json: async () => body };
}

// Multi-character (not single-letter) creds/token so the "never leaks
// credentials" assertions below are meaningful substring checks, not
// accidental passes.
const APP_KEY = 'app-key-secret';
const USER_KEY = 'user-key-secret';
const TOKEN = 'bearer-token-abc123';
const AGENT_ID = '104';

function makeClient() {
  const budgeter = new AccountRateBudgeter();
  return { budgeter, client: new NetasistanClient(budgeter) };
}

describe('NetasistanClient', () => {
  beforeEach(() => {
    mockSafeFetch.mockReset();
    jest.restoreAllMocks();
  });

  describe('authenticate', () => {
    it('POSTs appKey/userKey to the auth URL and returns the bearer + a ~1h expiry when the response omits its own TTL', async () => {
      const { client } = makeClient();
      const before = Date.now();
      mockSafeFetch.mockResolvedValue(res(200, { token: TOKEN }));
      const r = await client.authenticate(APP_KEY, USER_KEY);

      expect(r.ok).toBe(true);
      expect(r.token).toBe(TOKEN);
      expect(r.expiresAt).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
      expect(r.expiresAt).toBeLessThanOrEqual(before + 61 * 60 * 1000);

      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://netasistanapi.netgsm.com.tr/api/auth');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ appKey: APP_KEY, userKey: USER_KEY });
    });

    it('honors an explicit expiresIn (seconds) from the response', async () => {
      const { client } = makeClient();
      const before = Date.now();
      mockSafeFetch.mockResolvedValue(res(200, { token: TOKEN, expiresIn: 1800 }));
      const r = await client.authenticate(APP_KEY, USER_KEY);
      expect(r.ok).toBe(true);
      expect(r.expiresAt).toBeGreaterThanOrEqual(before + 1799 * 1000);
      expect(r.expiresAt).toBeLessThanOrEqual(before + 1801 * 1000);
    });

    it('rejects a missing/blank appKey or userKey WITHOUT calling NetGSM', async () => {
      const { client } = makeClient();
      const r1 = await client.authenticate('', USER_KEY);
      expect(r1.ok).toBe(false);
      const r2 = await client.authenticate(APP_KEY, '   ');
      expect(r2.ok).toBe(false);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('a non-2xx HTTP status is a non-ok, non-retriable failure (unless 429)', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(401, null));
      const r = await client.authenticate(APP_KEY, USER_KEY);
      expect(r.ok).toBe(false);
      expect(r.retriable).toBe(false);
    });

    it('a 429 is retriable', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(429, null));
      const r = await client.authenticate(APP_KEY, USER_KEY);
      expect(r.ok).toBe(false);
      expect(r.retriable).toBe(true);
    });

    it('a response with no recognizable token field is a non-ok failure', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { foo: 'bar' }));
      const r = await client.authenticate(APP_KEY, USER_KEY);
      expect(r.ok).toBe(false);
      expect(r.token).toBeNull();
    });

    it('a transport error (rejected promise) never leaks the app-key/user-key', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockRejectedValue(new Error(`ECONNRESET appKey=${APP_KEY} userKey=${USER_KEY}`));
      const r = await client.authenticate(APP_KEY, USER_KEY);
      expect(r.ok).toBe(false);
      expect(r.message).not.toContain(APP_KEY);
      expect(r.message).not.toContain(USER_KEY);
    });

    it('spends the shared 60/min "netasistan" budget bucket, keyed by appKey', async () => {
      const { client, budgeter } = makeClient();
      for (let i = 0; i < 60; i++) budgeter.tryTake(APP_KEY, 'netasistan', 60, 60_000);
      const r = await client.authenticate(APP_KEY, USER_KEY);
      expect(r.ok).toBe(false);
      expect(r.retriable).toBe(true);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });
  });

  describe('getToken (cache + re-auth on expiry)', () => {
    it('authenticates once and reuses the cached bearer on a second call within the ~1h window', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { token: TOKEN }));

      const first = await client.getToken(APP_KEY, USER_KEY);
      const second = await client.getToken(APP_KEY, USER_KEY);

      expect(first.token).toBe(TOKEN);
      expect(second.token).toBe(TOKEN);
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    });

    it('re-authenticates once the cached token has expired', async () => {
      const { client } = makeClient();
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValue(1_000_000);
      mockSafeFetch.mockResolvedValue(res(200, { token: TOKEN, expiresIn: 3600 }));

      const first = await client.getToken(APP_KEY, USER_KEY);
      expect(first.token).toBe(TOKEN);
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);

      // Still well within the 1h window (only 10 minutes later) — cache hit.
      nowSpy.mockReturnValue(1_000_000 + 10 * 60 * 1000);
      await client.getToken(APP_KEY, USER_KEY);
      expect(mockSafeFetch).toHaveBeenCalledTimes(1);

      // Past expiry (65 minutes later) — must re-authenticate.
      nowSpy.mockReturnValue(1_000_000 + 65 * 60 * 1000);
      mockSafeFetch.mockResolvedValue(res(200, { token: 'fresh-token-xyz', expiresIn: 3600 }));
      const third = await client.getToken(APP_KEY, USER_KEY);
      expect(third.token).toBe('fresh-token-xyz');
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('caches independently per appKey', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValueOnce(res(200, { token: 'token-a' }));
      mockSafeFetch.mockResolvedValueOnce(res(200, { token: 'token-b' }));

      const a = await client.getToken('app-a', 'user-a');
      const b = await client.getToken('app-b', 'user-b');

      expect(a.token).toBe('token-a');
      expect(b.token).toBe('token-b');
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT serve a cached bearer to a different userKey under the same appKey', async () => {
      // The pair is jointly secret: a token minted for (appKey, user-a) must
      // never be handed to a caller presenting (appKey, user-b) — the cache
      // key covers both. Re-auths instead of returning the first token.
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValueOnce(res(200, { token: 'token-a' }));
      mockSafeFetch.mockResolvedValueOnce(res(200, { token: 'token-b' }));

      const a = await client.getToken(APP_KEY, 'user-a');
      const b = await client.getToken(APP_KEY, 'user-b');

      expect(a.token).toBe('token-a');
      expect(b.token).toBe('token-b');
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed auth attempt', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValueOnce(res(401, null));
      mockSafeFetch.mockResolvedValueOnce(res(200, { token: TOKEN }));

      const first = await client.getToken(APP_KEY, USER_KEY);
      expect(first.ok).toBe(false);
      const second = await client.getToken(APP_KEY, USER_KEY);
      expect(second.ok).toBe(true);
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('setBreak', () => {
    it('PUTs {agentId, reason} with a Bearer auth header to the break URL', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      const r = await client.setBreak(TOKEN, AGENT_ID, 'Lunch');
      expect(r).toEqual({ ok: true, code: '00', message: null, retriable: false });

      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://netasistanapi.netgsm.com.tr/api/break');
      expect(init.method).toBe('PUT');
      expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(init.body)).toEqual({ agentId: AGENT_ID, reason: 'Lunch' });
    });

    it('omits the reason field entirely when none is given', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      await client.setBreak(TOKEN, AGENT_ID);
      const [, init] = mockSafeFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ agentId: AGENT_ID });
    });

    it('rejects a missing token/agentId WITHOUT calling NetGSM', async () => {
      const { client } = makeClient();
      const r = await client.setBreak('', AGENT_ID);
      expect(r.ok).toBe(false);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });

    it('maps a {code, message} error envelope to a non-ok result', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '40', message: 'agent not found' }));
      const r = await client.setBreak(TOKEN, AGENT_ID);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('40');
      expect(r.message).toBe('agent not found');
    });

    it('a transport error never leaks the bearer token', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockRejectedValue(new Error(`ECONNRESET Bearer ${TOKEN}`));
      const r = await client.setBreak(TOKEN, AGENT_ID);
      expect(r.ok).toBe(false);
      expect(r.message).not.toContain(TOKEN);
    });

    it('spends the shared "netasistan" budget bucket, keyed by the bearer token', async () => {
      const { client, budgeter } = makeClient();
      for (let i = 0; i < 60; i++) budgeter.tryTake(TOKEN, 'netasistan', 60, 60_000);
      const r = await client.setBreak(TOKEN, AGENT_ID);
      expect(r.ok).toBe(false);
      expect(r.retriable).toBe(true);
      expect(mockSafeFetch).not.toHaveBeenCalled();
    });
  });

  describe('setQueue', () => {
    it('PUTs {agentId, join:true, queueName} to the queue URL', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      const r = await client.setQueue(TOKEN, AGENT_ID, true, 'sales-queue');
      expect(r).toEqual({ ok: true, code: '00', message: null, retriable: false });

      const [url, init] = mockSafeFetch.mock.calls[0];
      expect(url).toBe('https://netasistanapi.netgsm.com.tr/api/queue');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ agentId: AGENT_ID, join: true, queueName: 'sales-queue' });
    });

    it('sends join:false to leave the queue, and omits queueName when not given', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(200, { code: '00' }));
      await client.setQueue(TOKEN, AGENT_ID, false);
      const [, init] = mockSafeFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ agentId: AGENT_ID, join: false });
    });

    it('a non-2xx HTTP status is a non-ok failure', async () => {
      const { client } = makeClient();
      mockSafeFetch.mockResolvedValue(res(500, null));
      const r = await client.setQueue(TOKEN, AGENT_ID, true);
      expect(r.ok).toBe(false);
    });
  });
});
