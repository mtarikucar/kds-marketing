// ── safeFetch mock (the transport seam) ─────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import {
  refreshAccessToken,
  classifyGoogleError,
  isGoogleAuthError,
  googleAdsFetch,
  normalizeCustomerId,
  googleAdsApiVersion,
  GOOGLE_ADS_TOKEN_URL,
} from './google-ads.util';

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

const ORIG = process.env;
beforeEach(() => {
  process.env = { ...ORIG };
  mockSafeFetch.mockReset();
});
afterAll(() => {
  process.env = ORIG;
});

describe('refreshAccessToken', () => {
  it('exchanges the refresh token at the Google token endpoint (form POST)', async () => {
    process.env.GOOGLE_ADS_CLIENT_ID = 'CID';
    process.env.GOOGLE_ADS_CLIENT_SECRET = 'SEC';
    mockSafeFetch.mockResolvedValue(res(true, 200, { access_token: 'ya29.exch', expires_in: 3600 }));
    const tok = await refreshAccessToken('rt-exchange');
    expect(tok).toBe('ya29.exch');
    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toBe(GOOGLE_ADS_TOKEN_URL);
    expect(opts.method).toBe('POST');
    expect(opts.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(opts.body).toContain('grant_type=refresh_token');
    expect(opts.body).toContain('refresh_token=rt-exchange');
    expect(opts.body).toContain('client_id=CID');
    expect(opts.body).toContain('client_secret=SEC');
  });

  it('caches the minted access token (one exchange for repeat calls)', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { access_token: 'ya29.cache', expires_in: 3600 }));
    const a = await refreshAccessToken('rt-cache');
    const b = await refreshAccessToken('rt-cache');
    expect(a).toBe('ya29.cache');
    expect(b).toBe('ya29.cache');
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('re-mints once the cached token has expired', async () => {
    jest.useFakeTimers();
    try {
      mockSafeFetch
        .mockResolvedValueOnce(res(true, 200, { access_token: 'ya29.first', expires_in: 3600 }))
        .mockResolvedValueOnce(res(true, 200, { access_token: 'ya29.second', expires_in: 3600 }));
      expect(await refreshAccessToken('rt-expire')).toBe('ya29.first');
      jest.advanceTimersByTime(3_600_001);
      expect(await refreshAccessToken('rt-expire')).toBe('ya29.second');
      expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('throws with isAuthError on a dead/revoked refresh token (invalid_grant)', async () => {
    mockSafeFetch.mockResolvedValue(
      res(false, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
    );
    await expect(refreshAccessToken('rt-dead')).rejects.toMatchObject({ isAuthError: true });
  });

  it('does NOT flag a transient 500 as isAuthError (stays retry-friendly)', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 500, { error: 'internal_failure' }));
    await expect(refreshAccessToken('rt-5xx')).rejects.not.toMatchObject({ isAuthError: true });
  });

  it('throws (isAuthError) immediately when no refresh token is supplied', async () => {
    await expect(refreshAccessToken('')).rejects.toMatchObject({ isAuthError: true });
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});

describe('classifyGoogleError', () => {
  it('flags 401 UNAUTHENTICATED as an auth error', () => {
    const e = classifyGoogleError(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'bad creds' } });
    expect(e.isAuthError).toBe(true);
    expect(e.status).toBe('UNAUTHENTICATED');
    expect(e.message).toBe('bad creds');
  });

  it('does NOT flag PERMISSION_DENIED (403) as an auth error', () => {
    const e = classifyGoogleError(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'no perm' } });
    expect(e.isAuthError).toBe(false);
  });

  it('flags an authenticationError detail even without a 401 status', () => {
    const e = classifyGoogleError(400, {
      error: {
        code: 400,
        message: 'x',
        details: [{ errors: [{ errorCode: { authenticationError: 'OAUTH_TOKEN_INVALID' } }] }],
      },
    });
    expect(e.isAuthError).toBe(true);
  });

  it('does NOT flag an authorizationError detail (config problem, not the token)', () => {
    const e = classifyGoogleError(403, {
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        message: 'x',
        details: [{ errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' } }] }],
      },
    });
    expect(e.isAuthError).toBe(false);
  });

  it('unwraps a streamed one-element array error body', () => {
    const e = classifyGoogleError(401, [{ error: { status: 'UNAUTHENTICATED', message: 'm' } }]);
    expect(e.isAuthError).toBe(true);
    expect(e.message).toBe('m');
  });
});

describe('isGoogleAuthError', () => {
  it('true for a thrown error carrying isAuthError', () => {
    expect(isGoogleAuthError(Object.assign(new Error('x'), { isAuthError: true }))).toBe(true);
  });
  it('true for a non-ok result whose error is an auth error', () => {
    expect(isGoogleAuthError({ ok: false, error: { isAuthError: true } })).toBe(true);
  });
  it('false for a plain error / ok result / non-object', () => {
    expect(isGoogleAuthError(new Error('nope'))).toBe(false);
    expect(isGoogleAuthError({ ok: true, error: null })).toBe(false);
    expect(isGoogleAuthError(null)).toBe(false);
  });
});

describe('googleAdsFetch', () => {
  beforeEach(() => {
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV-TOK';
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = '123-456-7890';
    delete process.env.GOOGLE_ADS_API_VERSION;
  });

  it('sends bearer + developer-token + login-customer-id (digits only) and posts JSON to the versioned base', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { results: [] }));
    const r = await googleAdsFetch('/customers/999/googleAds:searchStream', {
      accessToken: 'AT',
      body: { query: 'q' },
    });
    expect(r.ok).toBe(true);
    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toBe('https://googleads.googleapis.com/v17/customers/999/googleAds:searchStream');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer AT');
    expect(opts.headers['developer-token']).toBe('DEV-TOK');
    expect(opts.headers['login-customer-id']).toBe('1234567890'); // dashes stripped
    expect(JSON.parse(opts.body)).toEqual({ query: 'q' });
  });

  it('honors GOOGLE_ADS_API_VERSION and omits login-customer-id when unset', async () => {
    process.env.GOOGLE_ADS_API_VERSION = 'v18';
    delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    mockSafeFetch.mockResolvedValue(res(true, 200, {}));
    await googleAdsFetch('/customers/1:x', { accessToken: 'AT' });
    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toContain('/v18/');
    expect(opts.headers['login-customer-id']).toBeUndefined();
  });

  it('classifies a non-ok response into a populated error', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 401, { error: { status: 'UNAUTHENTICATED', message: 'bad' } }));
    const r = await googleAdsFetch('/x', { accessToken: 'AT' });
    expect(r.ok).toBe(false);
    expect(r.error.isAuthError).toBe(true);
    expect(r.error.message).toBe('bad');
  });
});

describe('helpers', () => {
  it('normalizeCustomerId strips non-digits', () => {
    expect(normalizeCustomerId('123-456-7890')).toBe('1234567890');
    expect(normalizeCustomerId(null)).toBe('');
  });

  it('googleAdsApiVersion falls back to v17 for invalid values', () => {
    process.env.GOOGLE_ADS_API_VERSION = 'not-a-version';
    expect(googleAdsApiVersion()).toBe('v17');
    process.env.GOOGLE_ADS_API_VERSION = 'v20';
    expect(googleAdsApiVersion()).toBe('v20');
  });
});
