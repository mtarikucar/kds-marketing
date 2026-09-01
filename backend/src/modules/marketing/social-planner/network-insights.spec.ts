import * as metaUtil from '../../../common/util/meta-graph.util';
import * as linkedinUtil from '../../../common/util/linkedin-api.util';
import * as fetchMod from '../../../common/util/safe-fetch';
import { sealSecret } from '../../../common/crypto/secret-box.helper';
import {
  fetchAccountInsights,
  fetchPostInsights,
  networkSupportsInsights,
} from './network-insights';
import { AccountRow } from './network-adapters';

// Module-factory mocks, not jest.spyOn on a namespace: under @swc/jest a
// namespace spy does not take, so the real transport would run and the specs
// would silently hit the network.
//
// Only the TRANSPORT is replaced here. classifyMetaError is spread back in from
// the real module on purpose: the error fixtures below are built by pushing a
// realistic Meta error body through it, which is the only way these specs can
// say anything true about how a body is classified.
jest.mock('../../../common/util/meta-graph.util', () => ({
  ...jest.requireActual('../../../common/util/meta-graph.util'),
  metaGraphFetch: jest.fn(),
}));
jest.mock('../../../common/util/linkedin-api.util', () => ({
  linkedinRest: jest.fn(),
  linkedinUpload: jest.fn(),
  isLinkedinAuthError: jest.fn(() => false),
}));
jest.mock('../../../common/util/safe-fetch');

const metaFetch = metaUtil.metaGraphFetch as jest.Mock;
const liRest = linkedinUtil.linkedinRest as jest.Mock;
const safeFetch = fetchMod.safeFetch as jest.Mock;

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

/** A successful MetaGraphResult. */
const graphOk = (data: any) => ({ ok: true, status: 200, data, error: null });

/**
 * A Meta error BODY, shaped the way Graph actually answers.
 *
 * `type: 'OAuthException'` is the default because that is what Meta really
 * sends — for dead tokens AND for permission errors AND for rate limits alike.
 * A fixture that omitted it would quietly stop testing the thing that matters.
 */
const metaError = (message: string, code: number | null, extra: Record<string, unknown> = {}) => ({
  error: { message, type: 'OAuthException', code, ...extra },
});

/**
 * A failed MetaGraphResult assembled the way runGraph assembles one: the body
 * pushed through the REAL classifyMetaError.
 *
 * The previous version of this helper took `isAuthError` as an argument and
 * hand-fed it into the result, which made every auth assertion in this file a
 * test of the fixture rather than of the code. That is precisely how the
 * missing-scope guard below sat here passing while a #200 — OAuthException,
 * like every other Meta error — was being forwarded as "reconnect this
 * account".
 */
const graphFail = (body: any, status = 400) => ({
  ok: false,
  status,
  data: body,
  error: metaUtil.classifyMetaError(status, body),
});
/** Meta insights payload shape: data[].values[].value. */
const metric = (name: string, value: unknown) => ({ name, period: 'lifetime', values: [{ value }] });

const liOk = (data: any) => ({ ok: true, status: 200, data, restliId: null, error: null });
const liFail = (message: string, status = 403) => ({
  ok: false,
  status,
  data: null,
  restliId: null,
  error: { message, status, serviceErrorCode: null, isAuthError: status === 401, raw: null },
});

/** A safeFetch-shaped Response. */
const httpRes = (json: any, ok = true, status = ok ? 200 : 400) =>
  ({ ok, status, json: async () => json, headers: { get: () => null } }) as any;

const account = (over: Partial<AccountRow> & { network: string }): AccountRow => ({
  id: 'acc1',
  externalId: 'EXT1',
  accessToken: sealSecret('TOKEN'),
  accountType: null,
  ...over,
});

beforeAll(() => {
  process.env.MARKETING_SECRET_KEY = MASTER_KEY;
  process.env.META_APP_ID = 'app';
  process.env.META_APP_SECRET = 'secret';
  process.env.INSTAGRAM_APP_ID = 'igapp';
  process.env.INSTAGRAM_APP_SECRET = 'igsecret';
  process.env.LINKEDIN_CLIENT_ID = 'li';
  process.env.LINKEDIN_CLIENT_SECRET = 'lisecret';
  process.env.TIKTOK_CLIENT_KEY = 'tk';
  process.env.TIKTOK_CLIENT_SECRET = 'ts';
  process.env.X_CLIENT_ID = 'x';
  process.env.X_CLIENT_SECRET = 'xs';
});
afterAll(() => {
  for (const k of [
    'MARKETING_SECRET_KEY',
    'META_APP_ID',
    'META_APP_SECRET',
    'INSTAGRAM_APP_ID',
    'INSTAGRAM_APP_SECRET',
    'LINKEDIN_CLIENT_ID',
    'LINKEDIN_CLIENT_SECRET',
    'TIKTOK_CLIENT_KEY',
    'TIKTOK_CLIENT_SECRET',
    'X_CLIENT_ID',
    'X_CLIENT_SECRET',
  ]) {
    delete process.env[k];
  }
});
beforeEach(() => {
  metaFetch.mockReset();
  liRest.mockReset();
  safeFetch.mockReset();
});

describe('networkSupportsInsights', () => {
  it('is true only for the networks with a readable API', () => {
    for (const n of ['FACEBOOK', 'INSTAGRAM', 'INSTAGRAM_LOGIN', 'LINKEDIN', 'TIKTOK', 'TWITTER']) {
      expect(networkSupportsInsights(n)).toBe(true);
    }
    for (const n of ['PINTEREST', 'GMB', 'MYSPACE']) {
      expect(networkSupportsInsights(n)).toBe(false);
    }
  });
});

describe('Facebook insights', () => {
  it('post: maps the four metrics and derives engagements from reactions + clicks', async () => {
    metaFetch.mockResolvedValueOnce(
      graphOk({
        data: [
          metric('post_impressions', 1000),
          metric('post_impressions_unique', 820),
          metric('post_clicks', 41),
          metric('post_reactions_by_type_total', { like: 30, love: 5, wow: 2 }),
        ],
      }),
    );
    const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'PAGE_1');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      impressions: 1000,
      reach: 820,
      clicks: 41,
      likes: 37,
      engagements: 78,
    });
    expect(metaFetch.mock.calls[0][0]).toBe('/PAGE_1/insights');
    expect(metaFetch.mock.calls[0][1].query.metric).toContain('post_reactions_by_type_total');
  });

  it('post: an expired token surfaces as isAuthError so the caller can stamp reauth', async () => {
    const body = metaError(
      'Error validating access token: Session has expired',
      190,
      { error_subcode: 463 },
    );
    // The fixture is real: the shared classifier condemns this one too.
    expect(metaUtil.classifyMetaError(400, body).isAuthError).toBe(true);
    metaFetch.mockResolvedValueOnce(graphFail(body));
    const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'PAGE_1');
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(true);
    expect(r.error).toContain('Error validating access token');
  });

  it('post: a missing read_insights scope degrades to ok:false, NOT unsupported', async () => {
    const body = metaError('(#200) Requires read_insights permission to manage the object', 200);
    // The shared classifier calls this an auth error, because Meta stamps
    // OAuthException on permission failures too. Forwarding that verdict is
    // what would tell every Page owner to reconnect a working account.
    expect(metaUtil.classifyMetaError(400, body).isAuthError).toBe(true);
    metaFetch.mockResolvedValueOnce(graphFail(body));
    const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'PAGE_1');
    expect(r.ok).toBe(false);
    expect(r.unsupported).toBe(false);
    expect(r.isAuthError).toBe(false);
    // …but it is still RECORDED, so coverage can report the missing grant.
    expect(r.error).toContain('read_insights');
  });

  it('post: a rate limit (#4) is recorded but is NEVER a reauth', async () => {
    const body = metaError('(#4) Application request limit reached', 4);
    expect(metaUtil.classifyMetaError(400, body).isAuthError).toBe(true);
    metaFetch.mockResolvedValueOnce(graphFail(body));
    const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'PAGE_1');
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(false);
    expect(r.error).toContain('request limit reached');
  });

  it('post: a permission error that arrives as a 401 is still not a reauth', async () => {
    // Meta is not consistent about the status it pairs with #10, and a bare
    // "401 ⇒ dead token" rule would condemn the credential on this one.
    metaFetch.mockResolvedValueOnce(graphFail(metaError('(#10) requires read_insights', 10), 401));
    const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'PAGE_1');
    expect(r.isAuthError).toBe(false);
  });

  it('post: a session-invalidation SUBCODE is a reauth even without code 190', async () => {
    // The subcode set lives in meta-graph.util; this proves the read path is
    // still asking it rather than carrying a second copy of the list.
    metaFetch.mockResolvedValueOnce(
      graphFail({ error: { message: 'The session has been invalidated', code: 102, error_subcode: 460 } }),
    );
    const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'PAGE_1');
    expect(r.isAuthError).toBe(true);
  });

  it('account: followers survive a denied page-insights call, with the reason kept in raw', async () => {
    metaFetch
      .mockResolvedValueOnce(graphOk({ followers_count: 1234 }))
      .mockResolvedValueOnce(graphFail(metaError('(#10) requires read_insights', 10)));
    const r = await fetchAccountInsights(account({ network: 'FACEBOOK' }));
    expect(r.ok).toBe(true);
    expect(r.data.followers).toBe(1234);
    expect(r.data.impressions).toBeUndefined();
    expect((r.data.raw as any).insightsError).toContain('read_insights');
  });

  it('account: both calls succeeding gives followers + day metrics', async () => {
    metaFetch
      .mockResolvedValueOnce(graphOk({ fan_count: 99 }))
      .mockResolvedValueOnce(graphOk({ data: [metric('page_impressions', 500), metric('page_views_total', 12)] }));
    const r = await fetchAccountInsights(account({ network: 'FACEBOOK' }));
    expect(r.data).toMatchObject({ followers: 99, impressions: 500, profileViews: 12 });
  });
});

describe('Instagram insights (Page-linked)', () => {
  it('post: feed metric set maps and derives engagements', async () => {
    metaFetch.mockResolvedValueOnce(
      graphOk({
        data: [
          metric('impressions', 900),
          metric('reach', 700),
          metric('saved', 11),
          metric('likes', 60),
          metric('comments', 4),
          metric('shares', 3),
        ],
      }),
    );
    const r = await fetchPostInsights(account({ network: 'INSTAGRAM' }), 'IGMEDIA1');
    expect(r.data).toMatchObject({ impressions: 900, reach: 700, saves: 11, likes: 60, engagements: 78 });
  });

  it('post: a Reel 400 on the feed metric set is retried with the reels set', async () => {
    metaFetch
      .mockResolvedValueOnce(graphFail(metaError('(#100) metric[0] must be a valid insights metric', 100)))
      .mockResolvedValueOnce(
        graphOk({
          data: [
            metric('plays', 5000),
            metric('reach', 4200),
            metric('likes', 300),
            metric('comments', 20),
            metric('shares', 15),
            metric('total_interactions', 400),
          ],
        }),
      );
    const r = await fetchPostInsights(account({ network: 'INSTAGRAM' }), 'REEL1');
    expect(r.ok).toBe(true);
    expect(metaFetch).toHaveBeenCalledTimes(2);
    expect(metaFetch.mock.calls[1][1].query.metric).toContain('plays');
    // plays is a VIDEO VIEW, never folded into impressions.
    expect(r.data).toMatchObject({ videoViews: 5000, impressions: 0, reach: 4200, engagements: 400 });
  });

  it('post: a non-metric error is NOT retried', async () => {
    metaFetch.mockResolvedValueOnce(graphFail(metaError('(#10) requires instagram_manage_insights', 10)));
    const r = await fetchPostInsights(account({ network: 'INSTAGRAM' }), 'IGMEDIA1');
    expect(metaFetch).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('instagram_manage_insights');
    // The scope the connect flow never asked for is not a dead credential.
    expect(r.isAuthError).toBe(false);
  });

  it('account: a denied profile read is an error, not a demand to reconnect', async () => {
    // The PRIMARY call of the account read: its failure fails the whole read,
    // so this is the arm that would have stamped reauth_required on every IG
    // Business account in the product the day the sweep first ran.
    metaFetch.mockResolvedValueOnce(
      graphFail(metaError('(#10) Application does not have permission for this action', 10)),
    );
    const r = await fetchAccountInsights(account({ network: 'INSTAGRAM' }));
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(false);
  });

  it('account: a genuinely dead token on the profile read IS a reauth', async () => {
    metaFetch.mockResolvedValueOnce(
      graphFail(metaError('Error validating access token: the user has changed their password', 190)),
    );
    const r = await fetchAccountInsights(account({ network: 'INSTAGRAM' }));
    expect(r.isAuthError).toBe(true);
  });

  it('account: followers + day insights', async () => {
    metaFetch
      .mockResolvedValueOnce(graphOk({ followers_count: 5000, media_count: 40 }))
      .mockResolvedValueOnce(
        graphOk({ data: [metric('impressions', 30), metric('reach', 25), metric('profile_views', 7)] }),
      );
    const r = await fetchAccountInsights(account({ network: 'INSTAGRAM' }));
    expect(r.data).toMatchObject({ followers: 5000, impressions: 30, reach: 25, profileViews: 7 });
  });
});

describe('Instagram Login insights (graph.instagram.com)', () => {
  it('post: calls the Instagram-hosted graph with a bearer token', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes({ data: [metric('impressions', 10), metric('reach', 9), metric('likes', 2)] }),
    );
    const r = await fetchPostInsights(account({ network: 'INSTAGRAM_LOGIN' }), 'M1');
    expect(r.ok).toBe(true);
    const [url, init] = safeFetch.mock.calls[0];
    expect(url).toContain('https://graph.instagram.com/M1/insights');
    expect(init.headers.Authorization).toBe('Bearer TOKEN');
    // metaGraphFetch must NOT be used for this host — different app, no proof.
    expect(metaFetch).not.toHaveBeenCalled();
  });

  it('post: retries with the reels metric set on a metric-availability 400', async () => {
    safeFetch
      .mockResolvedValueOnce(httpRes({ error: { message: 'metric[0] is not available' } }, false))
      .mockResolvedValueOnce(httpRes({ data: [metric('plays', 77)] }));
    const r = await fetchPostInsights(account({ network: 'INSTAGRAM_LOGIN' }), 'M1');
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(r.data.videoViews).toBe(77);
  });

  it('post: code 190 is an auth error', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes({ error: { message: 'Session expired', code: 190 } }, false, 400),
    );
    const r = await fetchPostInsights(account({ network: 'INSTAGRAM_LOGIN' }), 'M1');
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(true);
  });

  it('post: an OAuthException PERMISSION error is not an auth error', async () => {
    // This flow never asked for instagram_business_manage_insights, so every
    // insights call it makes comes back exactly like this. Reading the type
    // field as a dead token would demand a reconnect on all of them.
    safeFetch.mockResolvedValueOnce(
      httpRes(
        { error: { message: '(#10) Application does not have permission', type: 'OAuthException', code: 10 } },
        false,
        400,
      ),
    );
    const r = await fetchPostInsights(account({ network: 'INSTAGRAM_LOGIN' }), 'M1');
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(false);
    expect(r.error).toContain('does not have permission');
  });

  it('account: an OAuthException permission error on the node read is not a reauth either', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes(
        { error: { message: '(#200) Requires instagram_business_basic', type: 'OAuthException', code: 200 } },
        false,
        400,
      ),
    );
    const r = await fetchAccountInsights(account({ network: 'INSTAGRAM_LOGIN' }));
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(false);
  });

  it('account: a 401 on the node read IS a reauth', async () => {
    safeFetch.mockResolvedValueOnce(httpRes({ error: { message: 'Invalid OAuth token' } }, false, 401));
    const r = await fetchAccountInsights(account({ network: 'INSTAGRAM_LOGIN' }));
    expect(r.isAuthError).toBe(true);
  });

  it('account: reads followers_count off the node', async () => {
    safeFetch.mockResolvedValueOnce(httpRes({ followers_count: 42, media_count: 3 }));
    const r = await fetchAccountInsights(account({ network: 'INSTAGRAM_LOGIN' }));
    expect(r.data.followers).toBe(42);
  });
});

describe('LinkedIn insights', () => {
  it('post: an ORG share maps totalShareStatistics and ignores the engagement RATE', async () => {
    liRest.mockResolvedValueOnce(
      liOk({
        elements: [
          {
            totalShareStatistics: {
              impressionCount: 2000,
              uniqueImpressionsCount: 1500,
              clickCount: 30,
              likeCount: 20,
              commentCount: 5,
              shareCount: 2,
              // A RATE, not a count — must never reach the integer column.
              engagement: 0.0285,
            },
          },
        ],
      }),
    );
    const r = await fetchPostInsights(
      account({ network: 'LINKEDIN', accountType: 'LI_ORG', externalId: '999' }),
      'urn:li:share:123',
    );
    expect(r.data).toMatchObject({ impressions: 2000, reach: 1500, clicks: 30, engagements: 57 });
    const query = liRest.mock.calls[0][1].query;
    expect(query.organizationalEntity).toBe('urn:li:organization:999');
    expect(query.shares).toBe('List(urn:li:share:123)');
  });

  it('post: a ugcPost urn goes under the ugcPosts parameter, not shares', async () => {
    liRest.mockResolvedValueOnce(liOk({ elements: [{ totalShareStatistics: { impressionCount: 1 } }] }));
    await fetchPostInsights(
      account({ network: 'LINKEDIN', accountType: 'LI_ORG', externalId: '9' }),
      'urn:li:ugcPost:777',
    );
    const query = liRest.mock.calls[0][1].query;
    expect(query.ugcPosts).toBe('List(urn:li:ugcPost:777)');
    expect(query.shares).toBeUndefined();
  });

  it('post: a PERSONAL profile is unsupported — no call, no error', async () => {
    const r = await fetchPostInsights(
      account({ network: 'LINKEDIN', accountType: 'LI_PERSON' }),
      'urn:li:share:1',
    );
    expect(r.ok).toBe(true);
    expect(r.unsupported).toBe(true);
    expect(liRest).not.toHaveBeenCalled();
  });

  it('post: a missing r_organization_social grant is a plain error (403, not reauth)', async () => {
    liRest.mockResolvedValueOnce(liFail('Not enough permissions to access: GET organizationalEntityShareStatistics', 403));
    const r = await fetchPostInsights(
      account({ network: 'LINKEDIN', accountType: 'LI_ORG' }),
      'urn:li:share:1',
    );
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(false);
    expect(r.unsupported).toBe(false);
  });

  it('post: a 401 IS reauth', async () => {
    liRest.mockResolvedValueOnce(liFail('Invalid access token', 401));
    const r = await fetchPostInsights(
      account({ network: 'LINKEDIN', accountType: 'LI_ORG' }),
      'urn:li:share:1',
    );
    expect(r.isAuthError).toBe(true);
  });

  it('account: networkSizes gives followers; a denied page-stats call degrades', async () => {
    liRest
      .mockResolvedValueOnce(liOk({ firstDegreeSize: 8400 }))
      .mockResolvedValueOnce(liFail('Not enough permissions', 403));
    const r = await fetchAccountInsights(account({ network: 'LINKEDIN', accountType: 'LI_ORG', externalId: '5' }));
    expect(r.ok).toBe(true);
    expect(r.data.followers).toBe(8400);
    expect((r.data.raw as any).pageStatsError).toContain('Not enough permissions');
  });

  it('account: page statistics supply profileViews when granted', async () => {
    liRest
      .mockResolvedValueOnce(liOk({ firstDegreeSize: 10 }))
      .mockResolvedValueOnce(
        liOk({ elements: [{ totalPageStatistics: { views: { allPageViews: { pageViews: 64 } } } }] }),
      );
    const r = await fetchAccountInsights(account({ network: 'LINKEDIN', accountType: 'LI_ORG', externalId: '5' }));
    expect(r.data).toMatchObject({ followers: 10, profileViews: 64 });
  });
});

describe('TikTok insights', () => {
  it('post: resolves a stored publish_id to a video id before querying', async () => {
    safeFetch
      .mockResolvedValueOnce(httpRes({ data: { publicaly_available_post_id: ['7123'] }, error: { code: 'ok' } }))
      .mockResolvedValueOnce(
        httpRes({
          data: { videos: [{ id: '7123', view_count: 900, like_count: 40, comment_count: 6, share_count: 4 }] },
          error: { code: 'ok' },
        }),
      );
    const r = await fetchPostInsights(account({ network: 'TIKTOK' }), 'v_pub_url~v2.123');
    expect(safeFetch.mock.calls[0][0]).toContain('/v2/post/publish/status/fetch/');
    expect(safeFetch.mock.calls[1][0]).toContain('/v2/video/query/');
    expect(JSON.parse(safeFetch.mock.calls[1][1].body)).toEqual({ filters: { video_ids: ['7123'] } });
    expect(r.data).toMatchObject({ impressions: 900, videoViews: 900, likes: 40, engagements: 50 });
  });

  it('post: a bare video id skips the resolution hop', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes({ data: { videos: [{ id: '77', view_count: 1 }] }, error: { code: 'ok' } }),
    );
    const r = await fetchPostInsights(account({ network: 'TIKTOK' }), '77');
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });

  it('post: a still-processing publish id is an error, not a row of zeros', async () => {
    safeFetch.mockResolvedValueOnce(httpRes({ data: { status: 'PROCESSING_UPLOAD' }, error: { code: 'ok' } }));
    const r = await fetchPostInsights(account({ network: 'TIKTOK' }), 'v_pub_url~v2.9');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not publicly available');
  });

  it('post: an error.code on an HTTP 200 is still a failure', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes({ error: { code: 'scope_not_authorized', message: 'video.list not granted' } }),
    );
    const r = await fetchPostInsights(account({ network: 'TIKTOK' }), '77');
    expect(r.ok).toBe(false);
    // A missing scope is NOT a reauth: reconnecting cannot grant it.
    expect(r.isAuthError).toBe(false);
    expect(r.error).toContain('video.list not granted');
  });

  it('post: an invalid access token IS a reauth', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes({ error: { code: 'access_token_invalid', message: 'token invalid' } }, false, 401),
    );
    const r = await fetchPostInsights(account({ network: 'TIKTOK' }), '77');
    expect(r.isAuthError).toBe(true);
  });

  it('account: user info gives follower_count', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes({ data: { user: { follower_count: 2500, likes_count: 9, video_count: 3 } }, error: { code: 'ok' } }),
    );
    const r = await fetchAccountInsights(account({ network: 'TIKTOK' }));
    expect(safeFetch.mock.calls[0][0]).toContain('fields=follower_count');
    expect(r.data.followers).toBe(2500);
  });
});

describe('X (Twitter) insights', () => {
  it('post: public_metrics map, with quotes counted as shares and bookmarks as saves', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes({
        data: {
          public_metrics: {
            impression_count: 4000,
            like_count: 50,
            reply_count: 5,
            retweet_count: 7,
            quote_count: 3,
            bookmark_count: 9,
          },
        },
      }),
    );
    const r = await fetchPostInsights(account({ network: 'TWITTER' }), '1900');
    expect(safeFetch.mock.calls[0][0]).toContain('/2/tweets/1900?tweet.fields=public_metrics');
    expect(r.data).toMatchObject({ impressions: 4000, likes: 50, comments: 5, shares: 10, saves: 9, engagements: 74 });
  });

  it('post: 401 is an auth error', async () => {
    safeFetch.mockResolvedValueOnce(httpRes({ title: 'Unauthorized' }, false, 401));
    const r = await fetchPostInsights(account({ network: 'TWITTER' }), '1');
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(true);
  });

  it('post: a missing tweet.read scope degrades to a plain error', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes({ title: 'Forbidden', detail: 'Your client app is not configured with tweet.read' }, false, 403),
    );
    const r = await fetchPostInsights(account({ network: 'TWITTER' }), '1');
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(false);
    expect(r.error).toContain('tweet.read');
  });

  it('account: /2/users/me gives followers', async () => {
    safeFetch.mockResolvedValueOnce(httpRes({ data: { public_metrics: { followers_count: 300, tweet_count: 12 } } }));
    const r = await fetchAccountInsights(account({ network: 'TWITTER' }));
    expect(r.data.followers).toBe(300);
  });
});

describe('unsupported networks', () => {
  it('Pinterest and GMB return ok:true + unsupported and make no call', async () => {
    for (const network of ['PINTEREST', 'GMB']) {
      const post = await fetchPostInsights(account({ network }), 'X1');
      const acct = await fetchAccountInsights(account({ network }));
      expect(post).toEqual({ ok: true, unsupported: true });
      expect(acct).toEqual({ ok: true, unsupported: true });
    }
    expect(safeFetch).not.toHaveBeenCalled();
    expect(metaFetch).not.toHaveBeenCalled();
  });

  it('an unknown network is an error, not silently unsupported', async () => {
    const r = await fetchPostInsights(account({ network: 'ORKUT' }), 'X1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Unknown network');
  });
});

/**
 * `permissionDenied` — the flag that lets the sweep stop.
 *
 * Every case below already returned ok:false with isAuthError:false, which was
 * correct and useless: the caller could tell it was not a reconnect, and had no
 * way to tell it was pointless to keep asking. A scope verdict belongs to the
 * (app, token, scope) triple and not to the object being asked about, so the
 * first refusal is the answer for every remaining call on that account — up to
 * five hundred of them per account per sweep, on the guaranteed day-one state of
 * this feature (none of the insights scopes is in social-oauth.config.ts yet).
 *
 * The two things it must NOT be are asserted alongside: never a reauth, and
 * never a throttle.
 */
describe('permissionDenied', () => {
  it('Meta: each of the four permission codes is a scope denial, and none is a reauth', async () => {
    // #200/#10 carry "Requires <scope> permission", #3 is "not available to your
    // app", #803 is the object-not-addressable-by-this-token Page variant.
    for (const code of [3, 10, 200, 803]) {
      metaFetch.mockResolvedValueOnce(graphFail(metaError(`(#${code}) denied`, code)));
      const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'P1');
      expect({ code, denied: r.permissionDenied, auth: r.isAuthError }).toEqual({
        code,
        denied: true,
        auth: false,
      });
    }
  });

  it('Meta: a THROTTLE is not a permission denial — the next tick may well answer', async () => {
    for (const code of [4, 17, 32, 613]) {
      metaFetch.mockResolvedValueOnce(graphFail(metaError(`(#${code}) limit reached`, code)));
      const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'P1');
      // Stopping the sweep here would drop the posts a transient limit would
      // have let through a second later.
      expect({ code, denied: r.permissionDenied }).toEqual({ code, denied: false });
    }
  });

  it('Meta: a dead token is a reauth and NOT a permission denial', async () => {
    metaFetch.mockResolvedValueOnce(graphFail(metaError('Error validating access token', 190)));
    const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'P1');
    expect(r.isAuthError).toBe(true);
    expect(r.permissionDenied).toBe(false);
  });

  it('Facebook account: a denied page-insights edge keeps the followers AND flags the scope', async () => {
    // The day-one shape for every connected Page: pages_read_engagement grants
    // the node (followers), read_insights grants the edge — and the SAME grant
    // gates the per-post edge, so this refusal predicts every post read the
    // sweep was about to make.
    metaFetch
      .mockResolvedValueOnce(graphOk({ followers_count: 1234 }))
      .mockResolvedValueOnce(graphFail(metaError('(#200) Requires read_insights permission', 200)));
    const r = await fetchAccountInsights(account({ network: 'FACEBOOK' }));

    expect(r.ok).toBe(true);
    expect(r.data.followers).toBe(1234);
    expect(r.permissionDenied).toBe(true);
    // The reason travels with the success, so the row can record WHY the rest
    // is missing.
    expect(r.error).toContain('read_insights');
    expect(r.isAuthError).toBeFalsy();
  });

  it('Facebook account: a TRANSIENT page-insights failure degrades without flagging the scope', async () => {
    metaFetch
      .mockResolvedValueOnce(graphOk({ followers_count: 1234 }))
      .mockResolvedValueOnce(graphFail(metaError('(#4) Application request limit reached', 4)));
    const r = await fetchAccountInsights(account({ network: 'FACEBOOK' }));
    expect(r.ok).toBe(true);
    expect(r.permissionDenied).toBeFalsy();
  });

  it('Instagram account: a denied insights edge flags the scope (same grant as the media edge)', async () => {
    metaFetch
      .mockResolvedValueOnce(graphOk({ followers_count: 77 }))
      .mockResolvedValueOnce(graphFail(metaError('(#10) requires instagram_manage_insights', 10)));
    const r = await fetchAccountInsights(account({ network: 'INSTAGRAM' }));
    expect(r.data.followers).toBe(77);
    expect(r.permissionDenied).toBe(true);
  });

  it('Instagram Login: an OAuthException permission code off the raw body is a scope denial', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes(
        { error: { message: '(#10) Application does not have permission', type: 'OAuthException', code: 10 } },
        false,
        400,
      ),
    );
    const r = await fetchPostInsights(account({ network: 'INSTAGRAM_LOGIN' }), 'M1');
    expect(r.permissionDenied).toBe(true);
    expect(r.isAuthError).toBe(false);
  });

  it('LinkedIn: a 403 on share stats is a scope denial; a 401 is a reauth', async () => {
    liRest.mockResolvedValueOnce(liFail('Not enough permissions to access', 403));
    const denied = await fetchPostInsights(
      account({ network: 'LINKEDIN', accountType: 'LI_ORG' }),
      'urn:li:share:1',
    );
    expect(denied.permissionDenied).toBe(true);
    expect(denied.isAuthError).toBe(false);

    liRest.mockResolvedValueOnce(liFail('Invalid access token', 401));
    const dead = await fetchPostInsights(
      account({ network: 'LINKEDIN', accountType: 'LI_ORG' }),
      'urn:li:share:1',
    );
    expect(dead.isAuthError).toBe(true);
    expect(dead.permissionDenied).toBe(false);
  });

  it('LinkedIn account: a denied PAGE-STATS call does NOT flag the scope', async () => {
    // The deliberate exception to the Meta rule, and the reason the flag is set
    // per call rather than per network. LinkedIn's split is two calls behind TWO
    // grants: organizationPageStatistics wants the organization-admin product,
    // while the post reads want r_organization_social. Denying page views says
    // nothing about share statistics, and stopping the post loop on it would
    // throw away numbers we can actually read.
    liRest
      .mockResolvedValueOnce(liOk({ firstDegreeSize: 8400 }))
      .mockResolvedValueOnce(liFail('Not enough permissions', 403));
    const r = await fetchAccountInsights(
      account({ network: 'LINKEDIN', accountType: 'LI_ORG', externalId: '5' }),
    );
    expect(r.ok).toBe(true);
    expect(r.data.followers).toBe(8400);
    expect(r.permissionDenied).toBeFalsy();
  });

  it('TikTok: scope_not_authorized is a scope denial, an invalid token is not', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes({ error: { code: 'scope_not_authorized', message: 'video.list not granted' } }),
    );
    const denied = await fetchPostInsights(account({ network: 'TIKTOK' }), '77');
    expect(denied.permissionDenied).toBe(true);
    expect(denied.isAuthError).toBe(false);

    safeFetch.mockResolvedValueOnce(
      httpRes({ error: { code: 'access_token_invalid', message: 'token invalid' } }, false, 401),
    );
    const dead = await fetchPostInsights(account({ network: 'TIKTOK' }), '77');
    expect(dead.isAuthError).toBe(true);
    expect(dead.permissionDenied).toBe(false);
  });

  it('X: a 403 is a scope denial, a 401 is a reauth', async () => {
    safeFetch.mockResolvedValueOnce(
      httpRes({ title: 'Forbidden', detail: 'not configured with tweet.read' }, false, 403),
    );
    const denied = await fetchPostInsights(account({ network: 'TWITTER' }), '1');
    expect(denied.permissionDenied).toBe(true);
    expect(denied.isAuthError).toBe(false);

    safeFetch.mockResolvedValueOnce(httpRes({ title: 'Unauthorized' }, false, 401));
    const dead = await fetchPostInsights(account({ network: 'TWITTER' }), '1');
    expect(dead.isAuthError).toBe(true);
    expect(dead.permissionDenied).toBe(false);
  });
});

describe('never throws', () => {
  it('a transport throw (SSRF block / DNS failure) becomes ok:false', async () => {
    safeFetch.mockRejectedValue(new Error('SsrfBlockedError: blocked host'));
    const r = await fetchPostInsights(account({ network: 'TWITTER' }), '1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('blocked host');
  });

  it('a malformed provider payload becomes ok:false, not a crash', async () => {
    metaFetch.mockResolvedValueOnce(graphOk({ data: 'not-an-array' }));
    const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'P1');
    expect(r.ok).toBe(false);
  });

  it('an undecryptable token fails cleanly without calling the provider', async () => {
    const r = await fetchPostInsights(
      { id: 'a', network: 'FACEBOOK', externalId: 'P', accessToken: 'not-sealed' },
      'P1',
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('could not be decrypted');
    expect(metaFetch).not.toHaveBeenCalled();
  });

  it('an unconfigured network is inert (no call), reported as an error', async () => {
    const saved = process.env.META_APP_ID;
    delete process.env.META_APP_ID;
    const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), 'P1');
    process.env.META_APP_ID = saved;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not configured');
    expect(metaFetch).not.toHaveBeenCalled();
  });

  it('an empty externalPostId never reaches a provider', async () => {
    const r = await fetchPostInsights(account({ network: 'FACEBOOK' }), '');
    expect(r.ok).toBe(false);
    expect(metaFetch).not.toHaveBeenCalled();
  });
});
