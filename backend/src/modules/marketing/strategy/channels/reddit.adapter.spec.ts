import { isRedditConfigured, postToReddit } from './reddit.adapter';

describe('reddit.adapter', () => {
  const realFetch = global.fetch;
  const OLD = {
    id: process.env.REDDIT_CLIENT_ID,
    secret: process.env.REDDIT_CLIENT_SECRET,
    refresh: process.env.REDDIT_REFRESH_TOKEN,
  };

  const setCreds = () => {
    process.env.REDDIT_CLIENT_ID = 'cid';
    process.env.REDDIT_CLIENT_SECRET = 'csecret';
    process.env.REDDIT_REFRESH_TOKEN = 'rtoken';
  };
  const clearCreds = () => {
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    delete process.env.REDDIT_REFRESH_TOKEN;
  };

  afterEach(() => {
    global.fetch = realFetch;
    for (const [k, v] of [
      ['REDDIT_CLIENT_ID', OLD.id],
      ['REDDIT_CLIENT_SECRET', OLD.secret],
      ['REDDIT_REFRESH_TOKEN', OLD.refresh],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    jest.restoreAllMocks();
  });

  const SUBMIT = { subreddit: 'r/jeetagrowth', title: 'Devlog #3', text: 'We shipped the strategy engine.' };

  describe('isRedditConfigured', () => {
    it('is false unless all three env vars are present (inert without creds)', () => {
      clearCreds();
      expect(isRedditConfigured()).toBe(false);
      process.env.REDDIT_CLIENT_ID = 'cid';
      expect(isRedditConfigured()).toBe(false);
      setCreds();
      expect(isRedditConfigured()).toBe(true);
    });
  });

  describe('postToReddit', () => {
    it('is inert (ok:false) when not configured — no fetch', async () => {
      clearCreds();
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;
      const r = await postToReddit(SUBMIT);
      expect(r.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('obtains an access token via the refresh grant then submits a self post → ok', async () => {
      setCreds();
      const fetchMock = jest
        .fn()
        // 1) token endpoint
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'AT-1' }),
          text: async () => '',
        })
        // 2) submit endpoint
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ json: { errors: [], data: { id: 'abc123', name: 't3_abc123' } } }),
          text: async () => '',
        });
      global.fetch = fetchMock as any;

      const r = await postToReddit(SUBMIT);
      expect(r).toEqual({ ok: true, id: 'abc123' });

      // token call: Basic auth + refresh grant
      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
      expect(String(tokenUrl)).toContain('access_token');
      expect(tokenInit.headers.Authorization).toMatch(/^Basic /);
      expect(String(tokenInit.body)).toContain('grant_type=refresh_token');

      // submit call: Bearer token + kind=self + normalized sr (no r/ prefix)
      const [submitUrl, submitInit] = fetchMock.mock.calls[1];
      expect(String(submitUrl)).toContain('oauth.reddit.com/api/submit');
      expect(submitInit.headers.Authorization).toBe('Bearer AT-1');
      const body = String(submitInit.body);
      expect(body).toContain('kind=self');
      expect(body).toContain('sr=jeetagrowth');
      expect(body).toContain('title=');
    });

    it('returns {ok:false} when the token grant fails (no submit attempted)', async () => {
      setCreds();
      const fetchMock = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => 'invalid_grant',
      });
      global.fetch = fetchMock as any;

      const r = await postToReddit(SUBMIT);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('401');
      expect(fetchMock).toHaveBeenCalledTimes(1); // never reached submit
    });

    it('returns {ok:false} when the submit reports API errors on a 200', async () => {
      setCreds();
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'AT-1' }), text: async () => '' })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ json: { errors: [['SUBREDDIT_NOEXIST', 'that subreddit does not exist', 'sr']] } }),
          text: async () => '',
        });
      global.fetch = fetchMock as any;

      const r = await postToReddit(SUBMIT);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('SUBREDDIT_NOEXIST');
    });

    it('returns {ok:false} when fetch throws', async () => {
      setCreds();
      global.fetch = jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) as any;
      const r = await postToReddit(SUBMIT);
      expect(r).toEqual({ ok: false, error: 'ETIMEDOUT' });
    });
  });
});
