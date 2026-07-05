// ── safeFetch mock ──────────────────────────────────────────────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { pullMetaInsights } from './meta-ads.client';
import { pullTiktokInsights } from './tiktok-ads.client';

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

beforeEach(() => mockSafeFetch.mockReset());

describe('pullMetaInsights', () => {
  it('normalizes rows and counts deduplicated leads (source-specific over the generic aggregate)', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, {
        data: [
          {
            date_start: '2026-06-01',
            campaign_id: 'c1',
            spend: '12.34',
            impressions: '1000',
            clicks: '40',
            // Meta reports BOTH the generic `lead` total AND the grouped
            // instant-form type for the same 5 leads — summing both (the old
            // includes('lead') behaviour) double-counts to 10.
            actions: [
              { action_type: 'link_click', value: '40' },
              { action_type: 'lead', value: '5' },
              { action_type: 'onsite_conversion.lead_grouped', value: '5' },
            ],
          },
        ],
      }),
    );
    const rows = await pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: '2026-06-01',
      campaignId: 'c1',
      spend: 12.34,
      impressions: 1000,
      clicks: 40,
      leads: 5, // deduplicated — NOT 5 + 5
    });
  });

  it('sums distinct lead sources (instant-form grouped + website pixel)', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, {
        data: [{
          date_start: '2026-06-01', campaign_id: 'c1', spend: '1', impressions: '1', clicks: '1',
          actions: [
            { action_type: 'onsite_conversion.lead_grouped', value: '3' },
            { action_type: 'offsite_conversion.fb_pixel_lead', value: '2' },
          ],
        }],
      }),
    );
    const rows = await pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02');
    expect(rows[0].leads).toBe(5); // 3 + 2 — genuinely distinct sources
  });

  it('falls back to the generic lead total when no source-specific type is present', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, {
        data: [{
          date_start: '2026-06-01', campaign_id: 'c1', spend: '1', impressions: '1', clicks: '1',
          actions: [
            { action_type: 'link_click', value: '40' },
            { action_type: 'lead', value: '4' },
          ],
        }],
      }),
    );
    const rows = await pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02');
    expect(rows[0].leads).toBe(4);
  });

  it('requests the revenue fields (action_values + purchase_roas) from the provider', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { data: [] }));
    await pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02');
    const url = mockSafeFetch.mock.calls[0][0] as string;
    expect(url).toContain('action_values');
    expect(url).toContain('purchase_roas');
  });

  it('maps the deduplicated omni_purchase action value to conversionValue', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, {
        data: [{
          date_start: '2026-06-01', campaign_id: 'c1', spend: '10', impressions: '1', clicks: '1',
          action_values: [
            { action_type: 'omni_purchase', value: '150.50' },
            // pixel purchase overlaps omni — must NOT be double-counted
            { action_type: 'offsite_conversion.fb_pixel_purchase', value: '150.50' },
          ],
        }],
      }),
    );
    const rows = await pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02');
    expect(rows[0].conversionValue).toBe(150.5);
  });

  it('sums the distinct pixel + onsite purchase values when omni_purchase is absent', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, {
        data: [{
          date_start: '2026-06-01', campaign_id: 'c1', spend: '10', impressions: '1', clicks: '1',
          action_values: [
            { action_type: 'offsite_conversion.fb_pixel_purchase', value: '100' },
            { action_type: 'onsite_conversion.purchase', value: '20' },
          ],
        }],
      }),
    );
    const rows = await pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02');
    expect(rows[0].conversionValue).toBe(120);
  });

  it('derives conversionValue from purchase_roas × spend when action_values is absent', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, {
        data: [{
          date_start: '2026-06-01', campaign_id: 'c1', spend: '50', impressions: '1', clicks: '1',
          purchase_roas: [{ action_type: 'omni_purchase', value: '3.0' }],
        }],
      }),
    );
    const rows = await pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02');
    expect(rows[0].conversionValue).toBe(150);
  });

  it('reports conversionValue 0 when the row carries no purchase signal', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, {
        data: [{ date_start: '2026-06-01', campaign_id: 'c1', spend: '5', impressions: '1', clicks: '1' }],
      }),
    );
    const rows = await pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02');
    expect(rows[0].conversionValue).toBe(0);
  });

  it('prefixes a bare account id with act_', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { data: [] }));
    await pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02');
    const url = mockSafeFetch.mock.calls[0][0] as string;
    expect(url).toContain('/v19.0/act_42/insights');
  });

  it('does not double-prefix an id that already has act_', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { data: [] }));
    await pullMetaInsights('tok', 'act_42', '2026-06-01', '2026-06-02');
    const url = mockSafeFetch.mock.calls[0][0] as string;
    expect(url).toContain('/act_42/insights');
    expect(url).not.toContain('act_act_42');
  });

  it('throws on a provider error response', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 400, { error: { message: 'Invalid OAuth token' } }));
    await expect(pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02')).rejects.toThrow(/Meta ads 400/);
  });

  it('flags an auth error (401 / code 190) on the thrown error → drives TOKEN_EXPIRED', async () => {
    mockSafeFetch.mockResolvedValue(
      res(false, 401, { error: { code: 190, type: 'OAuthException', message: 'expired' } }),
    );
    await expect(pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02')).rejects.toMatchObject({
      isAuthError: true,
    });
  });

  it('does NOT flag a non-auth (500) error as isAuthError (stays retry-friendly)', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 500, { error: { message: 'server error' } }));
    await expect(pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02')).rejects.not.toMatchObject({
      isAuthError: true,
    });
  });

  it('follows paging.next until exhausted (no first-page truncation)', async () => {
    mockSafeFetch
      .mockResolvedValueOnce(
        res(true, 200, {
          data: [{ date_start: '2026-06-01', campaign_id: 'c1', spend: '1', impressions: '1', clicks: '1' }],
          paging: { next: 'https://graph.facebook.com/v19.0/act_42/insights?after=CURSOR2' },
        }),
      )
      .mockResolvedValueOnce(
        res(true, 200, {
          data: [{ date_start: '2026-06-02', campaign_id: 'c2', spend: '2', impressions: '2', clicks: '2' }],
          // no paging.next → last page
        }),
      );
    const rows = await pullMetaInsights('tok', '42', '2026-06-01', '2026-06-02');
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.campaignId)).toEqual(['c1', 'c2']);
    // second call used the provider-issued next URL verbatim
    expect(mockSafeFetch.mock.calls[1][0]).toContain('after=CURSOR2');
  });
});

describe('pullTiktokInsights', () => {
  it('normalizes rows from dimensions + metrics (conversion → leads)', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, {
        code: 0,
        data: {
          list: [
            {
              dimensions: { campaign_id: 'c9', stat_time_day: '2026-06-01 00:00:00' },
              metrics: { spend: '8.00', impressions: '500', clicks: '25', conversion: '4' },
            },
          ],
        },
      }),
    );
    const rows = await pullTiktokInsights('tok', 'adv_1', '2026-06-01', '2026-06-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: '2026-06-01',
      campaignId: 'c9',
      spend: 8,
      impressions: 500,
      clicks: 25,
      leads: 4,
    });
  });

  it('sends the advertiser id and the Access-Token header', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 0, data: { list: [] } }));
    await pullTiktokInsights('tok', 'adv_1', '2026-06-01', '2026-06-02');
    const [url, opts] = mockSafeFetch.mock.calls[0] as [string, any];
    expect(url).toContain('advertiser_id=adv_1');
    expect(opts.headers['Access-Token']).toBe('tok');
  });

  it('throws on a non-zero TikTok response code', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { code: 40001, message: 'Invalid advertiser_id' }));
    await expect(pullTiktokInsights('tok', 'adv_1', '2026-06-01', '2026-06-02')).rejects.toThrow(/TikTok ads/);
  });

  it('walks page_info.total_page until the last page (no truncation)', async () => {
    mockSafeFetch
      .mockResolvedValueOnce(
        res(true, 200, {
          code: 0,
          data: {
            page_info: { page: 1, total_page: 2 },
            list: [{ dimensions: { campaign_id: 'c1', stat_time_day: '2026-06-01' }, metrics: { spend: '1' } }],
          },
        }),
      )
      .mockResolvedValueOnce(
        res(true, 200, {
          code: 0,
          data: {
            page_info: { page: 2, total_page: 2 },
            list: [{ dimensions: { campaign_id: 'c2', stat_time_day: '2026-06-02' }, metrics: { spend: '2' } }],
          },
        }),
      );
    const rows = await pullTiktokInsights('tok', 'adv_1', '2026-06-01', '2026-06-02');
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.campaignId)).toEqual(['c1', 'c2']);
    expect(mockSafeFetch.mock.calls[1][0]).toContain('page=2');
  });
});
