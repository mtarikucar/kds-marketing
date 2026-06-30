// ── safeFetch mock (the seam linkedinRest transports over) ──────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { pullLinkedinInsights } from './linkedin-ads.client';

function res(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => mockSafeFetch.mockReset());

describe('pullLinkedinInsights', () => {
  it('maps analytics elements to AdMetricRow (string cost→number, pivot urn→campaignId, conversions→leads)', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, {
        elements: [
          {
            pivotValues: ['urn:li:sponsoredCampaign:777'],
            dateRange: { start: { year: 2026, month: 6, day: 1 }, end: { year: 2026, month: 6, day: 1 } },
            impressions: 1000,
            clicks: 40,
            costInLocalCurrency: '12.34',
            externalWebsiteConversions: 3,
          },
        ],
      }),
    );
    const rows = await pullLinkedinInsights('tok', '512345', '2026-06-01', '2026-06-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: '2026-06-01',
      campaignId: '777',
      spend: 12.34,
      impressions: 1000,
      clicks: 40,
      leads: 3,
    });
  });

  it('targets the adAnalytics finder with the sponsoredAccount in the accounts List and pivot=CAMPAIGN', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { elements: [] }));
    await pullLinkedinInsights('tok', '512345', '2026-06-01', '2026-06-02');
    const url = mockSafeFetch.mock.calls[0][0] as string;
    expect(url).toContain('/rest/adAnalytics');
    expect(url).toContain('q=analytics');
    expect(url).toContain('pivot=CAMPAIGN');
    expect(url).toContain('timeGranularity=DAILY');
    // dateRange parens are NOT percent-encoded; account urn members ARE
    expect(url).toContain('dateRange=(start:(year:2026,month:6,day:1),end:(year:2026,month:6,day:2))');
    expect(url).toContain('accounts=List(urn%3Ali%3AsponsoredAccount%3A512345)');
  });

  it('sends the LinkedIn-Version header and a Bearer token (via linkedinRest)', async () => {
    process.env.LINKEDIN_API_VERSION = '202406';
    mockSafeFetch.mockResolvedValue(res(true, 200, { elements: [] }));
    await pullLinkedinInsights('tok', '512345', '2026-06-01', '2026-06-02');
    const opts = mockSafeFetch.mock.calls[0][1] as any;
    expect(opts.headers['Authorization']).toBe('Bearer tok');
    expect(opts.headers['LinkedIn-Version']).toBe('202406');
  });

  it('throws with isAuthError true on a 401 (drives TOKEN_EXPIRED)', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 401, { message: 'Invalid access token', serviceErrorCode: 65601 }));
    await expect(
      pullLinkedinInsights('tok', '512345', '2026-06-01', '2026-06-02'),
    ).rejects.toMatchObject({ isAuthError: true });
  });

  it('throws WITHOUT isAuthError on a 403 (stays retry-friendly)', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 403, { message: 'Not enough permissions' }));
    await expect(
      pullLinkedinInsights('tok', '512345', '2026-06-01', '2026-06-02'),
    ).rejects.not.toMatchObject({ isAuthError: true });
  });
});
