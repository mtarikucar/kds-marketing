// ── safeFetch mock (the transport seam both the token exchange and the API call
//    ride over) ────────────────────────────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { pullGoogleInsights, setCampaignBudget, setCampaignStatus } from './google-ads.client';

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

// Every client call first mints an access token (refreshAccessToken → the token
// endpoint) then hits the Ads API. Dispatch by URL so tests only steer the API
// response and never fight over call ordering / the module token cache.
let apiResponse: any;
/** The non-token safeFetch call (the actual Ads API request). */
function apiCall(): [string, any] {
  return mockSafeFetch.mock.calls.find((c) => !String(c[0]).includes('oauth2.googleapis.com')) as [string, any];
}

const ORIG = process.env;
beforeEach(() => {
  process.env = { ...ORIG, GOOGLE_ADS_DEVELOPER_TOKEN: 'DEV', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '123-456-7890' };
  delete process.env.GOOGLE_ADS_API_VERSION;
  apiResponse = res(true, 200, [{ results: [] }]);
  mockSafeFetch.mockReset();
  mockSafeFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return res(true, 200, { access_token: 'ya29.client', expires_in: 3600 });
    }
    return apiResponse;
  });
});
afterAll(() => {
  process.env = ORIG;
});

describe('pullGoogleInsights', () => {
  it('parses a searchStream batch into AdMetricRow (cost_micros→spend, conversions→leads, conversions_value→conversionValue)', async () => {
    apiResponse = res(true, 200, [
      {
        results: [
          {
            campaign: { id: '555' },
            segments: { date: '2026-06-01' },
            metrics: {
              costMicros: '12340000',
              impressions: '1000',
              clicks: '40',
              conversions: 5,
              conversionsValue: 150.5,
            },
          },
        ],
      },
    ]);
    const rows = await pullGoogleInsights('RT', '111-222-3333', '2026-06-01', '2026-06-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: '2026-06-01',
      campaignId: '555',
      spend: 12.34, // 12_340_000 micros / 1e6
      impressions: 1000,
      clicks: 40,
      leads: 5,
      conversionValue: 150.5,
    });
  });

  it('builds the GAQL query and sends all three auth headers to the digit-only customer path', async () => {
    await pullGoogleInsights('RT', '111-222-3333', '2026-06-01', '2026-06-02');
    const [url, opts] = apiCall();
    expect(url).toContain('googleads.googleapis.com');
    expect(url).toContain('/customers/1112223333/googleAds:searchStream');
    expect(opts.headers.Authorization).toBe('Bearer ya29.client');
    expect(opts.headers['developer-token']).toBe('DEV');
    expect(opts.headers['login-customer-id']).toBe('1234567890');
    const body = JSON.parse(opts.body);
    expect(body.query).toContain('metrics.cost_micros');
    expect(body.query).toContain('metrics.conversions_value');
    expect(body.query).toContain("segments.date BETWEEN '2026-06-01' AND '2026-06-02'");
  });

  it('walks every streamed batch (no first-batch truncation)', async () => {
    apiResponse = res(true, 200, [
      { results: [{ campaign: { id: 'c1' }, segments: { date: '2026-06-01' }, metrics: { costMicros: '1000000' } }] },
      { results: [{ campaign: { id: 'c2' }, segments: { date: '2026-06-02' }, metrics: { costMicros: '2000000' } }] },
    ]);
    const rows = await pullGoogleInsights('RT', '111', '2026-06-01', '2026-06-02');
    expect(rows.map((r) => r.campaignId)).toEqual(['c1', 'c2']);
    expect(rows.map((r) => r.spend)).toEqual([1, 2]);
  });

  it('throws with isAuthError on a 401 / UNAUTHENTICATED body (drives TOKEN_EXPIRED)', async () => {
    apiResponse = res(false, 401, { error: { status: 'UNAUTHENTICATED', message: 'creds' } });
    await expect(pullGoogleInsights('RT', '111', '2026-06-01', '2026-06-02')).rejects.toMatchObject({
      isAuthError: true,
    });
  });

  it('throws WITHOUT isAuthError on a 403 / PERMISSION_DENIED (stays retry-friendly)', async () => {
    apiResponse = res(false, 403, { error: { status: 'PERMISSION_DENIED', message: 'no' } });
    await expect(pullGoogleInsights('RT', '111', '2026-06-01', '2026-06-02')).rejects.not.toMatchObject({
      isAuthError: true,
    });
  });
});

describe('setCampaignBudget', () => {
  it('converts major → micros and mutates the campaign budget with an amount_micros mask', async () => {
    apiResponse = res(true, 200, { results: [{ resourceName: 'customers/1112223333/campaignBudgets/BID' }] });
    const r = await setCampaignBudget('RT', '111-222-3333', 'BID', 25.5);
    expect(r).toEqual({ ok: true, id: 'customers/1112223333/campaignBudgets/BID' });
    const [url, opts] = apiCall();
    expect(url).toContain('/customers/1112223333/campaignBudgets:mutate');
    const op = JSON.parse(opts.body).operations[0];
    expect(op.update.resourceName).toBe('customers/1112223333/campaignBudgets/BID');
    expect(op.update.amountMicros).toBe('25500000'); // 25.5 × 1e6, as an int64 string
    expect(op.updateMask).toBe('amount_micros');
  });

  it('returns a non-ok write result (with isAuthError) on an auth failure', async () => {
    apiResponse = res(false, 401, { error: { status: 'UNAUTHENTICATED', message: 'expired' } });
    const r = await setCampaignBudget('RT', '111', 'BID', 10);
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(true);
    expect(r.error).toContain('Google set budget');
  });
});

describe('setCampaignStatus', () => {
  it('mutates the campaign status with a status mask (PAUSED)', async () => {
    apiResponse = res(true, 200, { results: [{ resourceName: 'customers/1112223333/campaigns/CID' }] });
    const r = await setCampaignStatus('RT', '111-222-3333', 'CID', 'PAUSED');
    expect(r.ok).toBe(true);
    const [url, opts] = apiCall();
    expect(url).toContain('/customers/1112223333/campaigns:mutate');
    const op = JSON.parse(opts.body).operations[0];
    expect(op.update.resourceName).toBe('customers/1112223333/campaigns/CID');
    expect(op.update.status).toBe('PAUSED');
    expect(op.updateMask).toBe('status');
  });

  it('passes a full resource name through unchanged (no id expansion)', async () => {
    apiResponse = res(true, 200, { results: [] });
    await setCampaignStatus('RT', '111-222-3333', 'customers/999/campaigns/XYZ', 'ENABLED');
    const op = JSON.parse(apiCall()[1].body).operations[0];
    expect(op.update.resourceName).toBe('customers/999/campaigns/XYZ');
    expect(op.update.status).toBe('ENABLED');
  });
});
