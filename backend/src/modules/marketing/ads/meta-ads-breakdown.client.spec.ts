// ── safeFetch mock (the seam metaGraphFetch/metaGraphFollow transport over) ──
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { pullMetaBreakdowns } from './meta-ads-breakdown.client';

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

/** An empty insights page — used for whichever breakdown family a test doesn't exercise. */
const EMPTY = () => res(true, 200, { data: [] });

beforeEach(() => mockSafeFetch.mockReset());

describe('pullMetaBreakdowns — placement family', () => {
  it('tags placement rows with ad identity, `${platform}:${position}`, and per-window counters', async () => {
    mockSafeFetch
      // call 1 = placement family
      .mockResolvedValueOnce(
        res(true, 200, {
          data: [
            {
              date_start: '2026-06-01',
              campaign_id: 'c1',
              adset_id: 'as1',
              ad_id: 'ad1',
              ad_name: 'Creative A',
              adset_name: 'Set A',
              publisher_platform: 'facebook',
              platform_position: 'feed',
              spend: '12.34',
              impressions: '1000',
              clicks: '40',
              // per-window sub-keys alongside the account-default `value`
              actions: [
                { action_type: 'onsite_conversion.lead_grouped', value: '5', '1d_click': '3', '7d_click': '4', '1d_view': '1' },
              ],
              action_values: [
                { action_type: 'omni_purchase', value: '150.50', '1d_click': '100.00', '7d_click': '140.00', '1d_view': '10.50' },
              ],
            },
          ],
        }),
      )
      // call 2 = demographic family (unused here)
      .mockResolvedValueOnce(EMPTY());

    const rows = await pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      level: 'ad',
      date: '2026-06-01',
      campaignId: 'c1',
      adSetId: 'as1',
      adSetName: 'Set A',
      adId: 'ad1',
      adName: 'Creative A',
      placement: 'facebook:feed',
      breakdownType: '',
      breakdownValue: '',
      spend: 12.34,
      impressions: 1000,
      clicks: 40,
      // account-default window stays in the canonical fields
      leads: 5,
      conversionValue: 150.5,
      // alternate attribution windows
      leads1dClick: 3,
      leads7dClick: 4,
      leads1dView: 1,
      convValue1dClick: 100,
      convValue7dClick: 140,
      convValue1dView: 10.5,
    });
  });

  it('joins publisher_platform:platform_position for a non-feed position (instagram:story)', async () => {
    mockSafeFetch
      .mockResolvedValueOnce(
        res(true, 200, {
          data: [
            {
              date_start: '2026-06-01', campaign_id: 'c1', adset_id: 'as1', ad_id: 'ad1',
              publisher_platform: 'instagram', platform_position: 'story',
              spend: '1', impressions: '1', clicks: '1',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(EMPTY());
    const rows = await pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02');
    expect(rows[0].placement).toBe('instagram:story');
  });

  it('deduplicates leads per window (source-specific over the generic `lead` aggregate)', async () => {
    mockSafeFetch
      .mockResolvedValueOnce(
        res(true, 200, {
          data: [
            {
              date_start: '2026-06-01', campaign_id: 'c1', adset_id: 'as1', ad_id: 'ad1',
              publisher_platform: 'facebook', platform_position: 'feed',
              spend: '1', impressions: '1', clicks: '1',
              // Meta reports BOTH the generic `lead` AND the grouped type for the same
              // leads, in EVERY window — summing both double-counts (5→10, 3→6, …).
              actions: [
                { action_type: 'lead', value: '5', '1d_click': '3', '7d_click': '4', '1d_view': '1' },
                { action_type: 'onsite_conversion.lead_grouped', value: '5', '1d_click': '3', '7d_click': '4', '1d_view': '1' },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(EMPTY());
    const rows = await pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02');
    expect(rows[0]).toMatchObject({ leads: 5, leads1dClick: 3, leads7dClick: 4, leads1dView: 1 });
  });
});

describe('pullMetaBreakdowns — demographic family', () => {
  it('folds age×gender cells into 1:1 age and gender marginal rows (collision-free, summed)', async () => {
    mockSafeFetch
      // call 1 = placement family (unused here)
      .mockResolvedValueOnce(EMPTY())
      // call 2 = demographic family
      .mockResolvedValueOnce(
        res(true, 200, {
          data: [
            {
              date_start: '2026-06-01', campaign_id: 'c1', adset_id: 'as1', ad_id: 'ad1', ad_name: 'Creative A',
              age: '25-34', gender: 'female',
              spend: '10', impressions: '100', clicks: '5',
              actions: [{ action_type: 'lead', value: '2', '1d_click': '1', '7d_click': '2', '1d_view': '0' }],
            },
            {
              date_start: '2026-06-01', campaign_id: 'c1', adset_id: 'as1', ad_id: 'ad1', ad_name: 'Creative A',
              age: '25-34', gender: 'male',
              spend: '6', impressions: '60', clicks: '3',
              actions: [{ action_type: 'lead', value: '1', '1d_click': '1', '7d_click': '1', '1d_view': '0' }],
            },
          ],
        }),
      );

    const rows = await pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02');
    // one age marginal ('25-34') + two gender marginals ('female','male')
    expect(rows).toHaveLength(3);

    const age = rows.find((r) => r.breakdownType === 'age' && r.breakdownValue === '25-34');
    expect(age).toMatchObject({
      level: 'ad',
      adId: 'ad1',
      placement: '',
      breakdownType: 'age',
      breakdownValue: '25-34',
      spend: 16, // 10 + 6 summed across both genders
      impressions: 160,
      clicks: 8,
      leads: 3, // 2 + 1
      leads1dClick: 2, // 1 + 1
      leads7dClick: 3, // 2 + 1
      leads1dView: 0,
    });

    const female = rows.find((r) => r.breakdownType === 'gender' && r.breakdownValue === 'female');
    const male = rows.find((r) => r.breakdownType === 'gender' && r.breakdownValue === 'male');
    expect(female).toMatchObject({ breakdownType: 'gender', spend: 10, leads: 2, placement: '' });
    expect(male).toMatchObject({ breakdownType: 'gender', spend: 6, leads: 1, placement: '' });
  });

  it('keeps demographic marginals for the same bucket on DIFFERENT ads separate', async () => {
    mockSafeFetch.mockResolvedValueOnce(EMPTY()).mockResolvedValueOnce(
      res(true, 200, {
        data: [
          { date_start: '2026-06-01', campaign_id: 'c1', adset_id: 'as1', ad_id: 'adA', age: '25-34', gender: 'female', spend: '4', impressions: '1', clicks: '1' },
          { date_start: '2026-06-01', campaign_id: 'c1', adset_id: 'as1', ad_id: 'adB', age: '25-34', gender: 'female', spend: '7', impressions: '1', clicks: '1' },
        ],
      }),
    );
    const rows = await pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02');
    const ageRows = rows.filter((r) => r.breakdownType === 'age');
    expect(ageRows.map((r) => [r.adId, r.spend]).sort()).toEqual([
      ['adA', 4],
      ['adB', 7],
    ]);
  });
});

describe('pullMetaBreakdowns — request shape & transport', () => {
  it('fires level=ad with the placement family first, then the age,gender family', async () => {
    mockSafeFetch.mockResolvedValueOnce(EMPTY()).mockResolvedValueOnce(EMPTY());
    await pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02');

    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    const placementUrl = decodeURIComponent(mockSafeFetch.mock.calls[0][0] as string);
    const demoUrl = decodeURIComponent(mockSafeFetch.mock.calls[1][0] as string);

    // every breakdown call is level=ad with the three attribution windows
    for (const u of [placementUrl, demoUrl]) {
      expect(u).toContain('level=ad');
      expect(u).toContain('action_attribution_windows=1d_click,7d_click,1d_view');
      expect(u).toContain('time_increment=1');
      // ad-level identity fields requested for tagging
      expect(u).toContain('ad_id');
      expect(u).toContain('adset_id');
      expect(u).toContain('ad_name');
    }
    // the two families are SEPARATE calls (Meta rejects placement + age/gender together)
    expect(placementUrl).toContain('breakdowns=publisher_platform,platform_position');
    expect(demoUrl).toContain('breakdowns=age,gender');
  });

  it('prefixes a bare account id with act_ (and does not double-prefix)', async () => {
    mockSafeFetch.mockResolvedValueOnce(EMPTY()).mockResolvedValueOnce(EMPTY());
    await pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02');
    expect(mockSafeFetch.mock.calls[0][0] as string).toContain('/v19.0/act_42/insights');

    mockSafeFetch.mockReset();
    mockSafeFetch.mockResolvedValueOnce(EMPTY()).mockResolvedValueOnce(EMPTY());
    await pullMetaBreakdowns('tok', 'act_42', '2026-06-01', '2026-06-02');
    const url = mockSafeFetch.mock.calls[0][0] as string;
    expect(url).toContain('/act_42/insights');
    expect(url).not.toContain('act_act_42');
  });

  it('follows paging.next within a family until exhausted (no first-page truncation)', async () => {
    mockSafeFetch
      // placement page 1 → has next
      .mockResolvedValueOnce(
        res(true, 200, {
          data: [{ date_start: '2026-06-01', campaign_id: 'c1', ad_id: 'ad1', publisher_platform: 'facebook', platform_position: 'feed', spend: '1', impressions: '1', clicks: '1' }],
          paging: { next: 'https://graph.facebook.com/v19.0/act_42/insights?after=CURSOR2' },
        }),
      )
      // placement page 2 → last
      .mockResolvedValueOnce(
        res(true, 200, {
          data: [{ date_start: '2026-06-02', campaign_id: 'c1', ad_id: 'ad2', publisher_platform: 'instagram', platform_position: 'story', spend: '2', impressions: '2', clicks: '2' }],
        }),
      )
      // demographic family → empty
      .mockResolvedValueOnce(EMPTY());

    const rows = await pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02');
    expect(mockSafeFetch).toHaveBeenCalledTimes(3); // 2 placement pages + 1 demographic
    expect(rows.map((r) => r.adId)).toEqual(['ad1', 'ad2']);
    // page 2 used the provider-issued next URL verbatim
    expect(mockSafeFetch.mock.calls[1][0]).toContain('after=CURSOR2');
  });
});

describe('pullMetaBreakdowns — errors', () => {
  it('throws on a provider error (first family fails fast, no second call)', async () => {
    mockSafeFetch.mockResolvedValueOnce(res(false, 400, { error: { message: 'Invalid parameter' } }));
    await expect(pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02')).rejects.toThrow(
      /Meta ads breakdown 400/,
    );
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('flags an auth error (401 / code 190) on the thrown error → drives TOKEN_EXPIRED', async () => {
    mockSafeFetch.mockResolvedValueOnce(
      res(false, 401, { error: { code: 190, type: 'OAuthException', message: 'expired' } }),
    );
    await expect(pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02')).rejects.toMatchObject({
      isAuthError: true,
    });
  });

  it('does NOT flag a non-auth (500) error as isAuthError (stays retry-friendly)', async () => {
    mockSafeFetch.mockResolvedValueOnce(res(false, 500, { error: { message: 'server error' } }));
    await expect(
      pullMetaBreakdowns('tok', '42', '2026-06-01', '2026-06-02'),
    ).rejects.not.toMatchObject({ isAuthError: true });
  });
});
