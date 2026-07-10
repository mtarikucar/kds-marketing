// ── safeFetch mock (transport seam for the token exchange + the upload) ──────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { uploadClickConversion, formatGoogleConversionDateTime } from './google-ads-conversions.client';

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

let apiResponse: any;
/** The non-token safeFetch call (the actual uploadClickConversions request). */
function apiCall(): [string, any] {
  return mockSafeFetch.mock.calls.find((c) => !String(c[0]).includes('oauth2.googleapis.com')) as [string, any];
}

const ORIG = process.env;
beforeEach(() => {
  process.env = { ...ORIG, GOOGLE_ADS_DEVELOPER_TOKEN: 'DEV', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '123-456-7890' };
  delete process.env.GOOGLE_ADS_CONVERSION_TZ_OFFSET_MIN;
  apiResponse = res(true, 200, { results: [{}] });
  mockSafeFetch.mockReset();
  mockSafeFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return res(true, 200, { access_token: 'ya29.conv', expires_in: 3600 });
    }
    return apiResponse;
  });
});
afterAll(() => {
  process.env = ORIG;
});

describe('uploadClickConversion', () => {
  it('POSTs the gclid conversion (expanded action + value/currency + partialFailure) to the digit-only customer path', async () => {
    apiResponse = res(true, 200, { results: [{ gclid: 'G123' }] });
    const r = await uploadClickConversion('RT', '111-222-3333', {
      gclid: 'G123',
      conversionAction: '456',
      conversionValue: 99.9,
      currencyCode: 'usd',
      conversionDateTime: '2026-06-01 10:00:00+03:00',
    });
    expect(r.ok).toBe(true);
    expect(r.receivedCount).toBe(1);
    expect(r.id).toBe('G123');

    const [url, opts] = apiCall();
    expect(url).toContain('/customers/1112223333:uploadClickConversions');
    expect(opts.headers.Authorization).toBe('Bearer ya29.conv');
    expect(opts.headers['developer-token']).toBe('DEV');
    const body = JSON.parse(opts.body);
    expect(body.partialFailure).toBe(true);
    const c = body.conversions[0];
    expect(c.gclid).toBe('G123');
    expect(c.conversionAction).toBe('customers/1112223333/conversionActions/456');
    expect(c.conversionValue).toBe(99.9);
    expect(c.currencyCode).toBe('USD');
    expect(c.conversionDateTime).toBe('2026-06-01 10:00:00+03:00');
  });

  it('passes a full conversionAction resource name through, omits value when absent, and defaults the datetime', async () => {
    await uploadClickConversion('RT', '111', {
      gclid: 'G',
      conversionAction: 'customers/999/conversionActions/AA',
    });
    const c = JSON.parse(apiCall()[1].body).conversions[0];
    expect(c.conversionAction).toBe('customers/999/conversionActions/AA');
    expect(c.conversionValue).toBeUndefined();
    expect(c.currencyCode).toBeUndefined();
    expect(c.conversionDateTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it('surfaces a partialFailureError (200 body) as a non-ok, non-auth result', async () => {
    apiResponse = res(true, 200, { partialFailureError: { code: 3, message: 'gclid not found' } });
    const r = await uploadClickConversion('RT', '111', { gclid: 'BAD', conversionAction: '1' });
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(false);
    expect(r.error).toContain('partial');
  });

  it('surfaces an auth failure without throwing (drives reauth)', async () => {
    apiResponse = res(false, 401, { error: { status: 'UNAUTHENTICATED', message: 'creds' } });
    const r = await uploadClickConversion('RT', '111', { gclid: 'G', conversionAction: '1' });
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(true);
    expect(r.error).toContain('Google upload conversion');
  });
});

describe('formatGoogleConversionDateTime', () => {
  it('formats an instant at the default +03:00 (Istanbul) offset', () => {
    // 2026-06-01T07:00:00Z + 3h = 10:00 wall clock at +03:00
    expect(formatGoogleConversionDateTime(new Date('2026-06-01T07:00:00Z'))).toBe('2026-06-01 10:00:00+03:00');
  });

  it('honors an explicit UTC (+0) offset', () => {
    expect(formatGoogleConversionDateTime(new Date('2026-06-01T07:05:09Z'), 0)).toBe('2026-06-01 07:05:09+00:00');
  });

  it('honors a negative offset', () => {
    expect(formatGoogleConversionDateTime(new Date('2026-06-01T07:00:00Z'), -300)).toBe('2026-06-01 02:00:00-05:00');
  });
});
