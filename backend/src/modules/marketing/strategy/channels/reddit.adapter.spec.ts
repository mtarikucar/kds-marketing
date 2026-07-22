import { isRedditConfigured, postToReddit } from './reddit.adapter';
import type { RedditTokenBundle } from './community-channel.service';

const SUBMIT = { subreddit: 'r/jeetagrowth', title: 'Devlog #3', text: 'We shipped the strategy engine.' };

/** A fake CommunityChannelService — token lifecycle is deep-mocked; no DB/live calls. */
function fakeSvc(bundle: RedditTokenBundle | null) {
  const saved: RedditTokenBundle[] = [];
  return {
    saved,
    getRedditToken: jest.fn(async () => bundle),
    saveRedditToken: jest.fn(async (_ws: string, b: RedditTokenBundle) => {
      saved.push(b);
    }),
    // The real service performs the token HTTP request; mock it per-test.
    redditTokenRequest: jest.fn(async () => {
      throw new Error('not mocked');
    }),
  } as any;
}

const future = () => Date.now() + 3600_000;
const past = () => Date.now() - 1000;

describe('reddit.adapter', () => {
  const realFetch = global.fetch;
  const OLD = { id: process.env.REDDIT_CLIENT_ID, secret: process.env.REDDIT_CLIENT_SECRET };

  const setCreds = () => {
    process.env.REDDIT_CLIENT_ID = 'cid';
    process.env.REDDIT_CLIENT_SECRET = 'csecret';
  };
  const clearCreds = () => {
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
  };

  afterEach(() => {
    global.fetch = realFetch;
    for (const [k, v] of [
      ['REDDIT_CLIENT_ID', OLD.id],
      ['REDDIT_CLIENT_SECRET', OLD.secret],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    jest.restoreAllMocks();
  });

  describe('isRedditConfigured', () => {
    it('is false without env creds even if the workspace has a connection', async () => {
      clearCreds();
      const svc = fakeSvc({ access: 'AT', refresh: 'RT', expiresAt: future() });
      await expect(isRedditConfigured('ws1', svc)).resolves.toBe(false);
    });

    it('is false when env creds exist but the workspace has not connected', async () => {
      setCreds();
      await expect(isRedditConfigured('ws1', fakeSvc(null))).resolves.toBe(false);
    });

    it('is true when env creds AND a per-workspace connection exist', async () => {
      setCreds();
      const svc = fakeSvc({ access: 'AT', refresh: 'RT', expiresAt: future() });
      await expect(isRedditConfigured('ws1', svc)).resolves.toBe(true);
    });
  });

  describe('postToReddit', () => {
    it('is inert (ok:false) without env creds — no fetch', async () => {
      clearCreds();
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;
      const r = await postToReddit('ws1', fakeSvc(null), SUBMIT);
      expect(r.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is inert when the workspace has not connected — no submit', async () => {
      setCreds();
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;
      const r = await postToReddit('ws1', fakeSvc(null), SUBMIT);
      expect(r.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('submits a self post with the workspace token (valid, not expired) → ok', async () => {
      setCreds();
      const svc = fakeSvc({ access: 'AT-1', refresh: 'RT', expiresAt: future() });
      const fetchMock = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ json: { errors: [], data: { id: 'abc123', name: 't3_abc123' } } }),
        text: async () => '',
      });
      global.fetch = fetchMock as any;

      const r = await postToReddit('ws1', svc, SUBMIT);
      expect(r).toEqual({ ok: true, id: 'abc123' });
      expect(svc.redditTokenRequest).not.toHaveBeenCalled(); // no refresh needed

      const [submitUrl, submitInit] = fetchMock.mock.calls[0];
      expect(String(submitUrl)).toContain('oauth.reddit.com/api/submit');
      expect(submitInit.headers.Authorization).toBe('Bearer AT-1');
      const body = String(submitInit.body);
      expect(body).toContain('kind=self');
      expect(body).toContain('sr=jeetagrowth'); // normalized (no r/ prefix)
      expect(body).toContain('title=');
    });

    it('refreshes an expired token (re-sealing the new bundle) then submits → ok', async () => {
      setCreds();
      const svc = fakeSvc({ access: 'OLD', refresh: 'RT-old', expiresAt: past() });
      svc.redditTokenRequest.mockResolvedValueOnce({ access: 'AT-2', refresh: 'RT-new', expiresAt: future() });
      const fetchMock = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ json: { errors: [], data: { id: 'zzz', name: 't3_zzz' } } }),
        text: async () => '',
      });
      global.fetch = fetchMock as any;

      const r = await postToReddit('ws1', svc, SUBMIT);
      expect(r).toEqual({ ok: true, id: 'zzz' });

      // refreshed via the refresh grant + re-sealed
      expect(svc.redditTokenRequest).toHaveBeenCalledWith(
        expect.objectContaining({ grant_type: 'refresh_token', refresh_token: 'RT-old' }),
      );
      expect(svc.saveRedditToken).toHaveBeenCalledTimes(1);
      expect(svc.saved[0]).toMatchObject({ access: 'AT-2', refresh: 'RT-new' });

      // submitted with the NEW token
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer AT-2');
    });

    it('falls back (ok:false) when the refresh grant fails — no submit', async () => {
      setCreds();
      const svc = fakeSvc({ access: 'OLD', refresh: 'RT-old', expiresAt: past() });
      svc.redditTokenRequest.mockRejectedValueOnce(new Error('invalid_grant'));
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;

      const r = await postToReddit('ws1', svc, SUBMIT);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('refresh failed');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns {ok:false} when the submit reports API errors on a 200', async () => {
      setCreds();
      const svc = fakeSvc({ access: 'AT-1', refresh: 'RT', expiresAt: future() });
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ json: { errors: [['SUBREDDIT_NOEXIST', 'that subreddit does not exist', 'sr']] } }),
        text: async () => '',
      }) as any;

      const r = await postToReddit('ws1', svc, SUBMIT);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('SUBREDDIT_NOEXIST');
    });

    it('returns {ok:false} when the submit fetch throws', async () => {
      setCreds();
      const svc = fakeSvc({ access: 'AT-1', refresh: 'RT', expiresAt: future() });
      global.fetch = jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) as any;
      const r = await postToReddit('ws1', svc, SUBMIT);
      expect(r).toEqual({ ok: false, error: 'ETIMEDOUT' });
    });
  });
});
