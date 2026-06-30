// backend/src/common/util/linkedin-api.util.spec.ts
import { safeFetch } from './safe-fetch';
import {
  linkedinRest,
  linkedinUpload,
  isLinkedinAuthError,
  linkedinApiVersion,
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

  it('linkedinApiVersion defaults to 202406 and honours a valid env override', () => {
    delete process.env.LINKEDIN_API_VERSION;
    expect(linkedinApiVersion()).toBe('202406');
    process.env.LINKEDIN_API_VERSION = '202506';
    expect(linkedinApiVersion()).toBe('202506');
    process.env.LINKEDIN_API_VERSION = 'garbage';
    expect(linkedinApiVersion()).toBe('202406');
  });

  it('injects Bearer + LinkedIn-Version + X-Restli headers on a GET', async () => {
    mockFetch.mockResolvedValue(resp({ elements: [] }));
    await linkedinRest('/rest/adAccountUsers', { accessToken: 'tok', query: { q: 'authenticatedUser' } });
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://api.linkedin.com/rest/adAccountUsers?q=authenticatedUser');
    const h = (init as any).headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['LinkedIn-Version']).toBe('202406');
    expect(h['X-Restli-Protocol-Version']).toBe('2.0.0');
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
