// ── safeFetch mock (the transport metaGraphFetch runs over) ─────────────────
const mockSafeFetch = jest.fn();
jest.mock('../../../common/util/safe-fetch', () => ({
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import {
  createAdSet,
  uploadAdImage,
  uploadAdVideo,
  waitVideoReady,
  createAdCreative,
  createAd,
} from './meta-ads-management.client';

function res(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

/** The URL passed to safeFetch for call `i`. */
function urlOf(i = 0): string {
  return mockSafeFetch.mock.calls[i][0] as string;
}

/** The parsed JSON body posted on call `i` (metaGraphFetch JSON.stringifies it). */
function bodyOf(i = 0): any {
  const init = mockSafeFetch.mock.calls[i][1] as any;
  return JSON.parse(init.body);
}

beforeEach(() => mockSafeFetch.mockReset());

// ─────────────────────────────────────────────────────────────── createAdSet
describe('createAdSet', () => {
  const targeting = {
    geo_locations: { countries: ['TR'] },
    age_min: 25,
    age_max: 45,
    publisher_platforms: ['facebook', 'instagram'],
  };

  it('posts to /act_42/adsets with daily_budget in MINOR units and targeting JSON-stringified', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: '900' }));
    const r = await createAdSet('tok', '42', {
      name: 'AS-1',
      campaignId: 'c1',
      optimizationGoal: 'LINK_CLICKS',
      billingEvent: 'IMPRESSIONS',
      dailyBudgetCents: 5000,
      targeting,
    });
    expect(r).toEqual({ ok: true, id: '900' });
    expect(urlOf()).toContain('/v19.0/act_42/adsets');

    const body = bodyOf();
    expect(body.campaign_id).toBe('c1');
    expect(body.optimization_goal).toBe('LINK_CLICKS');
    expect(body.billing_event).toBe('IMPRESSIONS');
    expect(body.daily_budget).toBe(5000);
    expect(body.bid_strategy).toBe('LOWEST_COST_WITHOUT_CAP');
    // targeting is a JSON string, NOT a nested object
    expect(typeof body.targeting).toBe('string');
    expect(JSON.parse(body.targeting)).toEqual(targeting);
  });

  it('defaults status to PAUSED and omits promoted_object when absent', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: '900' }));
    await createAdSet('tok', '42', {
      name: 'AS-1',
      campaignId: 'c1',
      optimizationGoal: 'LINK_CLICKS',
      billingEvent: 'IMPRESSIONS',
      dailyBudgetCents: 5000,
      targeting,
    });
    const body = bodyOf();
    expect(body.status).toBe('PAUSED');
    expect(body.promoted_object).toBeUndefined();
  });

  it('JSON-stringifies promoted_object (lead-gen page / conversion pixel) when provided', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: '900' }));
    await createAdSet('tok', '42', {
      name: 'AS-1',
      campaignId: 'c1',
      optimizationGoal: 'OFFSITE_CONVERSIONS',
      billingEvent: 'IMPRESSIONS',
      dailyBudgetCents: 5000,
      targeting,
      promotedObject: { pixel_id: 'px1', custom_event_type: 'LEAD' },
      status: 'ACTIVE',
    });
    const body = bodyOf();
    expect(body.status).toBe('ACTIVE');
    expect(typeof body.promoted_object).toBe('string');
    expect(JSON.parse(body.promoted_object)).toEqual({ pixel_id: 'px1', custom_event_type: 'LEAD' });
  });

  it('does not double-prefix an id already carrying act_', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: '900' }));
    await createAdSet('tok', 'act_42', {
      name: 'AS-1',
      campaignId: 'c1',
      optimizationGoal: 'LINK_CLICKS',
      billingEvent: 'IMPRESSIONS',
      dailyBudgetCents: 5000,
      targeting,
    });
    expect(urlOf()).toContain('/act_42/adsets');
    expect(urlOf()).not.toContain('act_act_42');
  });

  it('surfaces an auth error (code 190 / OAuthException) via fail() → drives TOKEN_EXPIRED', async () => {
    mockSafeFetch.mockResolvedValue(
      res(false, 401, { error: { code: 190, type: 'OAuthException', message: 'expired' } }),
    );
    const r = await createAdSet('tok', '42', {
      name: 'AS-1',
      campaignId: 'c1',
      optimizationGoal: 'LINK_CLICKS',
      billingEvent: 'IMPRESSIONS',
      dailyBudgetCents: 5000,
      targeting,
    });
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(true);
    expect(r.error).toContain('Meta create adset');
  });

  it('does NOT flag a non-auth (500) error as isAuthError (stays retry-friendly)', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 500, { error: { message: 'server error' } }));
    const r = await createAdSet('tok', '42', {
      name: 'AS-1',
      campaignId: 'c1',
      optimizationGoal: 'LINK_CLICKS',
      billingEvent: 'IMPRESSIONS',
      dailyBudgetCents: 5000,
      targeting,
    });
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────── uploadAdImage
describe('uploadAdImage', () => {
  it('posts base64 bytes to /act_42/adimages and returns the image hash', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, { images: { 'bytes.jpg': { hash: 'HASH123', url: 'https://x/y.jpg' } } }),
    );
    const r = await uploadAdImage('tok', '42', 'AAAAbase64');
    expect(r).toEqual({ ok: true, id: 'HASH123' });
    expect(urlOf()).toContain('/act_42/adimages');
    expect(bodyOf().bytes).toBe('AAAAbase64');
  });

  it('returns the hash from the first key regardless of its name', async () => {
    mockSafeFetch.mockResolvedValue(
      res(true, 200, { images: { some_other_key: { hash: 'ZZZ' } } }),
    );
    const r = await uploadAdImage('tok', '42', 'AAAA');
    expect(r.id).toBe('ZZZ');
  });

  it('surfaces a Graph error via fail()', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 400, { error: { message: 'bad image' } }));
    const r = await uploadAdImage('tok', '42', 'AAAA');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Meta upload image');
  });
});

// ────────────────────────────────────────────────────────────── uploadAdVideo
describe('uploadAdVideo', () => {
  it('posts {file_url,name} to /act_42/advideos and returns the video id', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: 'vid789' }));
    const r = await uploadAdVideo('tok', '42', 'https://cdn/x.mp4', 'MyVideo');
    expect(r).toEqual({ ok: true, id: 'vid789' });
    expect(urlOf()).toContain('/act_42/advideos');
    const body = bodyOf();
    expect(body.file_url).toBe('https://cdn/x.mp4');
    expect(body.name).toBe('MyVideo');
  });

  it('surfaces a Graph error via fail()', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 400, { error: { message: 'bad url' } }));
    const r = await uploadAdVideo('tok', '42', 'https://cdn/x.mp4', 'MyVideo');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Meta upload video');
  });
});

// ───────────────────────────────────────────────────────────── waitVideoReady
describe('waitVideoReady', () => {
  it('polls GET /{id}?fields=status and resolves once video_status is ready', async () => {
    mockSafeFetch
      .mockResolvedValueOnce(res(true, 200, { status: { video_status: 'processing' } }))
      .mockResolvedValueOnce(res(true, 200, { status: { video_status: 'ready' } }));
    const r = await waitVideoReady('tok', 'vid789', { intervalMs: 0, maxTries: 5 });
    expect(r).toEqual({ ok: true, id: 'vid789' });
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    expect(urlOf(0)).toContain('/v19.0/vid789');
    expect(urlOf(0)).toContain('fields=status');
  });

  it('fails fast when Meta reports the video errored', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { status: { video_status: 'error' } }));
    const r = await waitVideoReady('tok', 'vid789', { intervalMs: 0, maxTries: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('processing failed');
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up with a timeout error after maxTries while still processing', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { status: { video_status: 'processing' } }));
    const r = await waitVideoReady('tok', 'vid789', { intervalMs: 0, maxTries: 3 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('timed out');
    expect(mockSafeFetch).toHaveBeenCalledTimes(3);
  });

  it('propagates an auth error from the status poll via fail()', async () => {
    mockSafeFetch.mockResolvedValue(
      res(false, 401, { error: { code: 190, type: 'OAuthException', message: 'expired' } }),
    );
    const r = await waitVideoReady('tok', 'vid789', { intervalMs: 0, maxTries: 3 });
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(true);
    expect(r.error).toContain('Meta video status');
  });
});

// ──────────────────────────────────────────────────────────── createAdCreative
describe('createAdCreative', () => {
  it('wraps object_story_spec in JSON.stringify with page_id + link_data (image ad)', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: 'cr1' }));
    const linkData = {
      message: 'Book now',
      link: 'https://jeeta.app',
      image_hash: 'HASH123',
      call_to_action: { type: 'LEARN_MORE', value: { link: 'https://jeeta.app' } },
    };
    const r = await createAdCreative('tok', '42', {
      name: 'CR-1',
      pageId: 'page99',
      instagramActorId: 'ig55',
      linkData,
    });
    expect(r).toEqual({ ok: true, id: 'cr1' });
    expect(urlOf()).toContain('/act_42/adcreatives');

    const body = bodyOf();
    expect(body.name).toBe('CR-1');
    expect(typeof body.object_story_spec).toBe('string');
    const spec = JSON.parse(body.object_story_spec);
    expect(spec.page_id).toBe('page99');
    expect(spec.instagram_actor_id).toBe('ig55');
    expect(spec.link_data).toEqual(linkData);
    expect(spec.link_data.call_to_action.type).toBe('LEARN_MORE');
    expect(spec.video_data).toBeUndefined();
  });

  it('builds a video_data object_story_spec and omits instagram_actor_id when not given', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: 'cr2' }));
    const videoData = {
      video_id: 'vid789',
      image_url: 'https://cdn/thumb.jpg',
      message: 'Watch',
      call_to_action: { type: 'SHOP_NOW', value: { link: 'https://jeeta.app' } },
    };
    await createAdCreative('tok', '42', { name: 'CR-2', pageId: 'page99', videoData });
    const spec = JSON.parse(bodyOf().object_story_spec);
    expect(spec.page_id).toBe('page99');
    expect(spec.video_data).toEqual(videoData);
    expect(spec.link_data).toBeUndefined();
    expect(spec.instagram_actor_id).toBeUndefined();
  });

  it('surfaces a Graph error via fail()', async () => {
    mockSafeFetch.mockResolvedValue(res(false, 400, { error: { message: 'bad spec' } }));
    const r = await createAdCreative('tok', '42', { name: 'CR', pageId: 'p', linkData: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Meta create creative');
  });
});

// ───────────────────────────────────────────────────────────────────── createAd
describe('createAd', () => {
  it('posts adset_id + JSON-stringified creative to /act_42/ads and defaults PAUSED', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: 'ad1' }));
    const r = await createAd('tok', '42', { name: 'AD-1', adsetId: 'as1', creativeId: 'cr1' });
    expect(r).toEqual({ ok: true, id: 'ad1' });
    expect(urlOf()).toContain('/act_42/ads');

    const body = bodyOf();
    expect(body.adset_id).toBe('as1');
    expect(body.status).toBe('PAUSED');
    expect(typeof body.creative).toBe('string');
    expect(JSON.parse(body.creative)).toEqual({ creative_id: 'cr1' });
  });

  it('honors an explicit status override', async () => {
    mockSafeFetch.mockResolvedValue(res(true, 200, { id: 'ad1' }));
    await createAd('tok', '42', { name: 'AD-1', adsetId: 'as1', creativeId: 'cr1', status: 'ACTIVE' });
    expect(bodyOf().status).toBe('ACTIVE');
  });

  it('surfaces an auth error via fail()', async () => {
    mockSafeFetch.mockResolvedValue(
      res(false, 401, { error: { code: 190, type: 'OAuthException', message: 'expired' } }),
    );
    const r = await createAd('tok', '42', { name: 'AD-1', adsetId: 'as1', creativeId: 'cr1' });
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(true);
    expect(r.error).toContain('Meta create ad');
  });
});
