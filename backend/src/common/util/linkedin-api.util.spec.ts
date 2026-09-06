// backend/src/common/util/linkedin-api.util.spec.ts
import { safeFetch } from './safe-fetch';
import {
  linkedinRest,
  linkedinUpload,
  isLinkedinAuthError,
  linkedinApiVersion,
  LINKEDIN_DEFAULT_API_VERSION,
} from './linkedin-api.util';

jest.mock('./safe-fetch');
const mockFetch = safeFetch as jest.MockedFunction<typeof safeFetch>;

function resp(
  body: unknown,
  { status = 200, headers = {} as Record<string, string> } = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

describe('linkedin-api.util', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env };
    mockFetch.mockReset();
  });
  afterAll(() => {
    process.env = env;
  });

  // THE LIMIT OF WHAT A TEST HERE CAN KNOW, and it is worth being explicit about.
  //
  // Whether a given YYYYMM is a version LinkedIn publishes and still serves is a
  // fact about LinkedIn. This suite has no network and no fixture of their
  // version list, so any assertion of the form "the default is recent enough to
  // still be supported" would be a guess wearing a test's clothes — it would pass
  // for a version that does not exist at all.
  //
  // So this asserts only the two things the REPO owns:
  //  1. the shape — a well-formed YYYYMM with a real month, and one our own
  //     validator accepts (a default the env override would have rejected is a
  //     bug on its own);
  //  2. the one version we have DIRECT EVIDENCE about — 202406, whose production
  //     rejection (`Requested version 20240601 is not active`) is the reason this
  //     constant exists. Shipping back to it would re-break publishing.
  // Whether the current value is served is called out as unverified in the
  // constant's own comment and must be confirmed against LinkedIn's published
  // version list before deploy.
  it('LINKEDIN_DEFAULT_API_VERSION is a well-formed YYYYMM and not the version known to be retired', () => {
    expect(LINKEDIN_DEFAULT_API_VERSION).toMatch(/^\d{4}(0[1-9]|1[0-2])$/);
    expect(LINKEDIN_DEFAULT_API_VERSION).not.toBe('202406');
    delete process.env.LINKEDIN_API_VERSION;
    expect(linkedinApiVersion()).toBe(LINKEDIN_DEFAULT_API_VERSION);
  });

  it('linkedinApiVersion returns the default and honours a valid env override', () => {
    delete process.env.LINKEDIN_API_VERSION;
    expect(linkedinApiVersion()).toBe(LINKEDIN_DEFAULT_API_VERSION);
    process.env.LINKEDIN_API_VERSION = '202509';
    expect(linkedinApiVersion()).toBe('202509');
  });

  it('linkedinApiVersion rejects a malformed or impossible-month override', () => {
    for (const bad of ['garbage', '2024', '20240601', '202400', '202413', '202499', '']) {
      process.env.LINKEDIN_API_VERSION = bad;
      expect(linkedinApiVersion()).toBe(LINKEDIN_DEFAULT_API_VERSION);
    }
  });

  it('injects Bearer + LinkedIn-Version + X-Restli headers on a GET', async () => {
    delete process.env.LINKEDIN_API_VERSION;
    mockFetch.mockResolvedValue(resp({ elements: [] }));
    await linkedinRest('/rest/adAccountUsers', { accessToken: 'tok', query: { q: 'authenticatedUser' } });
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://api.linkedin.com/rest/adAccountUsers?q=authenticatedUser');
    const h = (init as any).headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['LinkedIn-Version']).toBe(LINKEDIN_DEFAULT_API_VERSION);
    expect(h['X-Restli-Protocol-Version']).toBe('2.0.0');
  });

  it('the LinkedIn-Version header carries the CONFIGURED version, not a baked-in literal', async () => {
    process.env.LINKEDIN_API_VERSION = '202512';
    mockFetch.mockResolvedValue(resp({ elements: [] }));
    await linkedinRest('/rest/posts', { accessToken: 'tok', method: 'POST', body: {} });
    const init = mockFetch.mock.calls[0][1] as any;
    expect(init.headers['LinkedIn-Version']).toBe('202512');
  });

  it('an explicit per-call version still wins over the configured one', async () => {
    process.env.LINKEDIN_API_VERSION = '202512';
    mockFetch.mockResolvedValue(resp({ elements: [] }));
    await linkedinRest('/rest/posts', { accessToken: 'tok', version: '202601' });
    const init = mockFetch.mock.calls[0][1] as any;
    expect(init.headers['LinkedIn-Version']).toBe('202601');
  });

  it('rewrites a retired-version rejection into an operator message and does NOT call it an auth error', async () => {
    process.env.LINKEDIN_API_VERSION = '202406';
    mockFetch.mockResolvedValue(
      resp({ message: 'Requested version 20240601 is not active', status: 426 }, { status: 426 }),
    );
    const r = await linkedinRest('/rest/posts', { accessToken: 'tok', method: 'POST', body: {} });
    expect(r.ok).toBe(false);
    // The message IS the product here (there is no isVersionError flag: nothing
    // in production branched on one). It has to name the version we sent and the
    // knob that moves it, because it is what lands in SocialPostTarget.error and
    // AdAccount.lastError — the latter is rendered to a human on
    // AdReportingPage; the former is reached through the API and the logs.
    expect(r.error!.message).toContain('202406');
    expect(r.error!.message).toContain('LINKEDIN_API_VERSION');
    expect(r.error!.message).toContain('is not active');
    // A retired version is a CONFIG problem, not a bad token: classifying it as an
    // auth error would tell every workspace to reconnect a LinkedIn that is fine.
    expect(r.error!.isAuthError).toBe(false);
    expect(isLinkedinAuthError(r)).toBe(false);
  });

  it('does not rewrite an ordinary failure as a version problem', async () => {
    mockFetch.mockResolvedValue(resp({ message: 'Not enough permissions' }, { status: 403 }));
    const r = await linkedinRest('/rest/posts', { accessToken: 'tok' });
    expect(r.error!.message).toBe('Not enough permissions');
    expect(r.error!.message).not.toContain('LINKEDIN_API_VERSION');
  });

  it('merges extra headers (rest.li method override) over the three standard ones', async () => {
    // The seam that lets a PARTIAL_UPDATE write go through this transport instead
    // of hand-rolling safeFetch and losing the classification above.
    process.env.LINKEDIN_API_VERSION = '202509';
    mockFetch.mockResolvedValue(resp(null, { status: 204 }));
    await linkedinRest('/rest/adCampaigns/c1', {
      accessToken: 'tok',
      method: 'POST',
      headers: { 'X-RestLi-Method': 'PARTIAL_UPDATE' },
      body: { patch: { $set: {} } },
    });
    const h = (mockFetch.mock.calls[0][1] as any).headers;
    expect(h['X-RestLi-Method']).toBe('PARTIAL_UPDATE');
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['LinkedIn-Version']).toBe('202509');
    expect(h['X-Restli-Protocol-Version']).toBe('2.0.0');
    expect(h['Content-Type']).toBe('application/json');
  });

  it('serialises a JSON body + sets Content-Type on a POST', async () => {
    mockFetch.mockResolvedValue(resp(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:99' } }));
    const r = await linkedinRest('/rest/posts', { accessToken: 'tok', method: 'POST', body: { author: 'urn:li:person:1' } });
    const init = mockFetch.mock.calls[0][1] as any;
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ author: 'urn:li:person:1' }));
    expect(r.ok).toBe(true);
    expect(r.restliId).toBe('urn:li:share:99'); // id arrives in the x-restli-id response header
  });

  it('classifies HTTP 401 as an auth error (flat result + isLinkedinAuthError)', async () => {
    mockFetch.mockResolvedValue(resp({ message: 'token expired', serviceErrorCode: 65601 }, { status: 401 }));
    const r = await linkedinRest('/rest/posts', { accessToken: 'tok', method: 'POST', body: {} });
    expect(r.ok).toBe(false);
    expect(r.error).not.toBeNull();
    expect(r.error!.isAuthError).toBe(true);
    expect(isLinkedinAuthError(r)).toBe(true); // accepts the whole result
    expect(isLinkedinAuthError(r.error)).toBe(true); // and the error
  });

  it('treats a 403 (permission/partner-gating) as a NON-auth error (no reconnect loop)', async () => {
    mockFetch.mockResolvedValue(resp({ message: 'Not enough permissions' }, { status: 403 }));
    const r = await linkedinRest('/rest/adAnalytics', { accessToken: 'tok' });
    expect(r.ok).toBe(false);
    expect(r.error!.isAuthError).toBe(false);
    expect(isLinkedinAuthError(r)).toBe(false);
  });

  it('returns a non-auth failure (never throws) on a network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));
    const r = await linkedinRest('/rest/posts', { accessToken: 'tok' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error!.isAuthError).toBe(false);
  });

  it('linkedinUpload PUTs raw bytes and returns the etag', async () => {
    mockFetch.mockResolvedValue(resp(null, { status: 201, headers: { etag: '/ambry/AQ123' } }));
    const out = await linkedinUpload('https://www.linkedin.com/dms-uploads/x', Buffer.from('abc'), 'image/png');
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/dms-uploads/');
    expect((init as any).method).toBe('PUT');
    expect((init as any).headers['Content-Type']).toBe('image/png');
    expect(out.ok).toBe(true);
    expect(out.etag).toBe('/ambry/AQ123');
  });
});
