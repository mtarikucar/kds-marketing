// backend/src/modules/marketing/channels/tiktok-business.util.spec.ts
import { safeFetch } from '../../../common/util/safe-fetch';
import {
  tiktokBusinessFetch,
  isTiktokBusinessAuthError,
  TiktokBusinessError,
  businessApiBaseUrl,
} from './tiktok-business.util';

jest.mock('../../../common/util/safe-fetch');
const mockedFetch = safeFetch as jest.MockedFunction<typeof safeFetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('tiktok-business.util', () => {
  afterEach(() => jest.resetAllMocks());

  it('returns ok with data on code 0', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ code: 0, message: 'OK', request_id: 'r1', data: { advertiser_ids: ['1'] } }),
    );
    const res = await tiktokBusinessFetch('/oauth2/advertiser/get/', { accessToken: 't' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ advertiser_ids: ['1'] });
      expect(res.requestId).toBe('r1');
    }
  });

  it('classifies an auth error from a non-zero auth code', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ code: 40105, message: 'Access token is invalid', request_id: 'r2' }, 200),
    );
    const res = await tiktokBusinessFetch('/report/integrated/get/', { accessToken: 't' });
    expect(res.ok).toBe(false);
    const errRes = res as { ok: false; error: TiktokBusinessError };
    expect(errRes.error).toBeInstanceOf(TiktokBusinessError);
    expect(errRes.error.code).toBe(40105);
    expect(isTiktokBusinessAuthError(errRes.error)).toBe(true);
  });

  it('classifies a non-auth business error as non-auth', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ code: 40000, message: 'param error' }, 200));
    const res = await tiktokBusinessFetch('/x/', { accessToken: 't' });
    expect(res.ok).toBe(false);
    const errRes = res as { ok: false; error: TiktokBusinessError };
    expect(isTiktokBusinessAuthError(errRes.error)).toBe(false);
  });

  it('treats a thrown network error as a (retryable) auth-agnostic failure', async () => {
    mockedFetch.mockRejectedValue(new Error('ECONNRESET'));
    const res = await tiktokBusinessFetch('/x/', { accessToken: 't' });
    expect(res.ok).toBe(false);
  });

  it('sends the Access-Token header and JSON body, and builds the v1.3 base URL', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ code: 0, data: {} }));
    await tiktokBusinessFetch('/report/integrated/get/', {
      accessToken: 'secret-token',
      method: 'POST',
      body: { advertiser_id: '1' },
    });
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe(`${businessApiBaseUrl()}/report/integrated/get/`);
    expect((init as any).headers['Access-Token']).toBe('secret-token');
    expect((init as any).body).toBe(JSON.stringify({ advertiser_id: '1' }));
  });
});
