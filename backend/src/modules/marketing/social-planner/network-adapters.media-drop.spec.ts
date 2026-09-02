import * as metaUtil from '../../../common/util/meta-graph.util';
import * as fetchMod from '../../../common/util/safe-fetch';
import { sealSecret } from '../../../common/crypto/secret-box.helper';
import { maxPublishableVideos, publishToNetwork, selectMediaForTarget } from './network-adapters';

jest.mock('../../../common/util/meta-graph.util', () => ({ metaGraphFetch: jest.fn() }));
jest.mock('../../../common/util/safe-fetch');

const metaFetch = metaUtil.metaGraphFetch as jest.Mock;
const safeFetch = fetchMod.safeFetch as jest.Mock;

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const ok = (data: any) => ({ ok: true, status: 200, data, error: null });
const resp = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
/** A media GET that hands back a small, in-cap image body. */
const imageBytes = () =>
  ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(1024),
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
  }) as unknown as Response;

const fbAccount = () =>
  ({ id: 'b', network: 'FACEBOOK', externalId: 'PAGE9', accessToken: sealSecret('TOK') }) as any;
const xAccount = () =>
  ({ id: 'x', network: 'TWITTER', externalId: 'u1', accessToken: sealSecret('TOK') }) as any;
const ttAccount = () =>
  ({
    id: 'c',
    network: 'TIKTOK',
    externalId: 'tt1',
    accessToken: sealSecret('TOK'),
    accountType: 'TIKTOK',
  }) as any;

const FIVE_CLIPS = [
  'https://cdn.example/beat1.mp4',
  'https://cdn.example/beat2.mp4',
  'https://cdn.example/beat3.mp4',
  'https://cdn.example/beat4.mp4',
  'https://cdn.example/beat5.mp4',
];

beforeAll(() => {
  process.env.MARKETING_SECRET_KEY = MASTER_KEY;
  process.env.META_APP_ID = 'app';
  process.env.META_APP_SECRET = 'secret';
  process.env.TIKTOK_CLIENT_KEY = 'k';
  process.env.TIKTOK_CLIENT_SECRET = 's';
  process.env.X_CLIENT_ID = 'xid';
  process.env.X_CLIENT_SECRET = 'xsecret';
});
afterAll(() => {
  delete process.env.MARKETING_SECRET_KEY;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.TIKTOK_CLIENT_KEY;
  delete process.env.TIKTOK_CLIENT_SECRET;
  delete process.env.X_CLIENT_ID;
  delete process.env.X_CLIENT_SECRET;
});
beforeEach(() => {
  metaFetch.mockReset();
  safeFetch.mockReset();
});

/**
 * A five-beat concept generates five clips and is CHARGED for five. Facebook's
 * feed and TikTok each publish ONE, by indexing (`videos[0]`, `mediaUrls[0]`),
 * and used to say nothing at all about the other four — no error, no warning,
 * no record anywhere that they had ever existed.
 *
 * These tests do not ask the adapters to publish more: a platform that accepts
 * one video accepts one video. They ask that the drop be VISIBLE.
 */
describe('publish adapters — media that cannot be published is reported, not discarded', () => {
  it('Facebook feed: publishes the first clip and reports the four it could not send', async () => {
    metaFetch.mockResolvedValueOnce(ok({ id: 'post-1' }));

    const r = await publishToNetwork(fbAccount(), 'caption', FIVE_CLIPS, {
      mediaMime: FIVE_CLIPS.map(() => 'video/mp4'),
    });

    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('post-1');
    // Still exactly one upload — the fix is honesty, not a second post.
    expect(metaFetch).toHaveBeenCalledTimes(1);
    expect(metaFetch.mock.calls[0][1].body.file_url).toBe(FIVE_CLIPS[0]);
    expect(r.droppedMedia).toEqual({
      count: 4,
      reason: expect.stringContaining('one video'),
    });
  });

  it('Facebook feed: a single clip drops nothing and says nothing', async () => {
    metaFetch.mockResolvedValueOnce(ok({ id: 'post-1' }));
    const r = await publishToNetwork(fbAccount(), 'caption', [FIVE_CLIPS[0]], {
      mediaMime: ['video/mp4'],
    });
    expect(r.ok).toBe(true);
    expect(r.droppedMedia).toBeUndefined();
  });

  it('Facebook feed: a video alongside images reports the images it dropped too', async () => {
    metaFetch.mockResolvedValueOnce(ok({ id: 'post-1' }));
    const r = await publishToNetwork(
      fbAccount(),
      'caption',
      [FIVE_CLIPS[0], 'https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
      { mediaMime: ['video/mp4', 'image/jpeg', 'image/jpeg'] },
    );
    expect(r.ok).toBe(true);
    expect(r.droppedMedia?.count).toBe(2);
  });

  it('TikTok: publishes one clip and reports the four it could not send', async () => {
    safeFetch
      // creator_info
      .mockResolvedValueOnce(
        resp({
          data: {
            privacy_level_options: ['PUBLIC_TO_EVERYONE'],
            comment_disabled: false,
            duet_disabled: false,
            stitch_disabled: false,
            max_video_post_duration_sec: 300,
          },
        }),
      )
      // video/init
      .mockResolvedValueOnce(resp({ data: { publish_id: 'pub1' } }))
      // status poll
      .mockResolvedValueOnce(resp({ data: { status: 'PUBLISH_COMPLETE' } }));

    const r = await publishToNetwork(ttAccount(), 'caption', FIVE_CLIPS);

    expect(r.ok).toBe(true);
    const initBody = JSON.parse(safeFetch.mock.calls[1][1].body);
    expect(initBody.source_info.video_url).toBe(FIVE_CLIPS[0]);
    expect(r.droppedMedia).toEqual({ count: 4, reason: expect.stringContaining('one video') });
  });

  /**
   * X's drop has TWO causes and the row has to name the RIGHT one.
   *
   * `selectMediaForTarget` gives TWITTER a video capacity of zero, so a video
   * never reaches this adapter at all — which is precisely why the old fixed
   * sentence ("X carries four IMAGES per post and no video") could only ever be
   * printed about an IMAGE, and in the interesting case about an image whose
   * upload had failed. An operator told "X carries no video" about a PNG X
   * simply refused has been sent to the wrong screen.
   */
  it('X: an image X refused is reported as a refused upload, not as a video limit', async () => {
    safeFetch
      .mockResolvedValueOnce(imageBytes()) // fetch the image
      .mockResolvedValueOnce(resp({ detail: 'unsupported media' })) // upload rejected
      .mockResolvedValueOnce(resp({ data: { id: 'tweet-1' } })); // the tweet still goes out

    const r = await publishToNetwork(xAccount(), 'caption', ['https://cdn.example/a.png'], {
      mediaMime: ['image/png'],
    });

    expect(r.ok).toBe(true);
    expect(r.droppedMedia?.count).toBe(1);
    expect(r.droppedMedia?.reason).toContain('refused');
    // The cause that CANNOT apply here must not be the one the row names.
    expect(r.droppedMedia?.reason).not.toContain('video');
  });

  it('X: the fifth image IS the four-per-post shape, and says so', async () => {
    for (let i = 0; i < 4; i++) {
      safeFetch
        .mockResolvedValueOnce(imageBytes())
        .mockResolvedValueOnce(resp({ data: { id: `m${i}` } }));
    }
    safeFetch.mockResolvedValueOnce(resp({ data: { id: 'tweet-2' } }));

    const urls = Array.from({ length: 6 }, (_, i) => `https://cdn.example/${i}.png`);
    const r = await publishToNetwork(xAccount(), 'caption', urls, {
      mediaMime: urls.map(() => 'image/png'),
    });

    expect(r.ok).toBe(true);
    expect(r.droppedMedia?.count).toBe(2);
    expect(r.droppedMedia?.reason).toContain('four images per post');
    expect(r.droppedMedia?.reason).not.toContain('refused');
  });

  it('a FAILED publish is never annotated with a drop — it sent nothing at all', async () => {
    metaFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      data: {},
      error: { httpStatus: 400, code: null, subcode: null, fbtraceId: null, message: 'nope', isAuthError: false },
    });
    const r = await publishToNetwork(fbAccount(), 'caption', FIVE_CLIPS, {
      mediaMime: FIVE_CLIPS.map(() => 'video/mp4'),
    });
    expect(r.ok).toBe(false);
    expect(r.droppedMedia).toBeUndefined();
  });
});

/**
 * The capability table is the SELECTOR: `selectMediaForTarget` reads it once per
 * target to decide that target's share of the post, and the content line reads
 * it before a human approves to say what each destination will receive. Each
 * number is what the adapter above physically does, so these assertions are the
 * contract between the two.
 */
describe('maxPublishableVideos — what each destination can actually carry', () => {
  it('knows the one-video destinations', () => {
    expect(maxPublishableVideos('FACEBOOK')).toBe(1);
    expect(maxPublishableVideos('TIKTOK')).toBe(1);
    expect(maxPublishableVideos('LINKEDIN')).toBe(1);
    expect(maxPublishableVideos('INSTAGRAM_LOGIN')).toBe(1);
  });

  it('knows Instagram carries ten in a FEED carousel but one as a Reel or Story', () => {
    expect(maxPublishableVideos('INSTAGRAM', 'FEED')).toBe(10);
    expect(maxPublishableVideos('INSTAGRAM', 'REEL')).toBe(1);
    expect(maxPublishableVideos('INSTAGRAM', 'STORY')).toBe(1);
  });

  it('knows the image-only destinations carry NO video', () => {
    // X uploads with media_category tweet_image; a Pinterest pin is an
    // image_url; a GMB local post is mediaFormat PHOTO. A video sent to any of
    // them is a file that never appears anywhere.
    expect(maxPublishableVideos('TWITTER')).toBe(0);
    expect(maxPublishableVideos('PINTEREST')).toBe(0);
    expect(maxPublishableVideos('GMB')).toBe(0);
  });

  it('promises an unknown network nothing', () => {
    expect(maxPublishableVideos('MYSPACE')).toBe(0);
  });
});


/**
 * MEDIA SELECTION IS PER TARGET, NOT ALL-OR-NOTHING.
 *
 * The defect this replaces refused the whole concept unless EVERY targeted
 * account could carry EVERY beat — seven of the eight networks, measured — so a
 * vertical-video feature worked on all-Instagram campaigns and nowhere else. A
 * post carries the clips that were made; each destination takes what it can, in
 * the plan's order, and says what it left behind.
 */
describe('selectMediaForTarget — each destination takes what it can carry', () => {
  const clips = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ url: `https://cdn.example/beat${i + 1}.mp4`, mime: 'video/mp4' }));

  it('gives Instagram the whole five-clip concept as a feed carousel', () => {
    const sel = selectMediaForTarget(clips(5), 'INSTAGRAM', 'FEED');
    expect(sel.media).toHaveLength(5);
    expect(sel.dropped).toBeNull();
    expect(sel.carriesNothing).toBe(false);
  });

  it('gives TikTok the FIRST clip and names the limit that left four behind', () => {
    const sel = selectMediaForTarget(clips(5), 'TIKTOK');
    // The first, in plan order — the hook, not "any one of them". A selection
    // that took the last would publish the call to action on its own.
    expect(sel.media.map((m) => m.url)).toEqual(['https://cdn.example/beat1.mp4']);
    expect(sel.dropped).toEqual({ count: 4, reason: 'TIKTOK carries 1 video per post' });
    expect(sel.carriesNothing).toBe(false);
  });

  it('preserves the plan order of everything it keeps', () => {
    const sel = selectMediaForTarget(clips(5), 'INSTAGRAM', 'FEED');
    expect(sel.media.map((m) => m.url)).toEqual(clips(5).map((m) => m.url));
  });

  it('an Instagram REEL is a one-video destination, unlike its feed', () => {
    expect(selectMediaForTarget(clips(5), 'INSTAGRAM', 'REEL').media).toHaveLength(1);
    expect(selectMediaForTarget(clips(5), 'INSTAGRAM', 'FEED').media).toHaveLength(5);
  });

  it('flags a video-only post aimed at a destination that carries NO video', () => {
    for (const network of ['TWITTER', 'PINTEREST', 'GMB', 'MYSPACE']) {
      const sel = selectMediaForTarget(clips(5), network);
      expect(sel.media).toEqual([]);
      expect(sel.carriesNothing).toBe(true);
      expect(sel.dropped).toEqual({ count: 5, reason: `${network} cannot carry video at all` });
    }
  });

  it('does NOT flag a text-only post — there is no media to fail to carry', () => {
    const sel = selectMediaForTarget([], 'TWITTER');
    expect(sel.carriesNothing).toBe(false);
    expect(sel.dropped).toBeNull();
  });

  it('does NOT flag an image post to an image network, and passes the images through', () => {
    // Only VIDEO is metered here: each adapter carries its own image shape and
    // reports its own overflow. A four-image tweet is a real tweet.
    const images = [1, 2, 3, 4].map((i) => ({ url: `https://cdn.example/${i}.jpg`, mime: 'image/jpeg' }));
    const sel = selectMediaForTarget(images, 'TWITTER');
    expect(sel.media).toHaveLength(4);
    expect(sel.carriesNothing).toBe(false);
    expect(sel.dropped).toBeNull();
  });

  it('keeps the images and drops only the videos a mixed post cannot place', () => {
    const mixed = [
      { url: 'https://cdn.example/beat1.mp4', mime: 'video/mp4' },
      { url: 'https://cdn.example/a.jpg', mime: 'image/jpeg' },
      { url: 'https://cdn.example/beat2.mp4', mime: 'video/mp4' },
    ];
    const sel = selectMediaForTarget(mixed, 'TWITTER');
    // The post still has something to say on X — so it is NOT a bare caption.
    expect(sel.media.map((m) => m.url)).toEqual(['https://cdn.example/a.jpg']);
    expect(sel.carriesNothing).toBe(false);
    expect(sel.dropped?.count).toBe(2);
  });

  it('reads video-ness off the URL when no mime came with it', () => {
    const sel = selectMediaForTarget([{ url: 'https://cdn.example/beat1.mp4' }], 'TWITTER');
    expect(sel.carriesNothing).toBe(true);
  });
});

/**
 * A DROP REASON NAMES THE LOSS THAT ACTUALLY HAPPENED.
 *
 * Three of these sentences named a cause that had not occurred: two were
 * printed on a branch that can drop nothing at all, and Facebook's multi-photo
 * sentence claimed a ten-photo limit over an upload Facebook had answered 200 to
 * without returning an id. Same class as the X one: one fixed sentence covering
 * two causes sends the customer to the wrong screen.
 */
describe('drop reasons — derived from the loss, not a fixed sentence', () => {
  const images = (n: number) =>
    Array.from({ length: n }, (_, i) => `https://cdn.example/${i + 1}.jpg`);

  it('Facebook multi-photo: an upload accepted WITHOUT a photo id is named as that, not as the ten-photo limit', async () => {
    // Four photos — nothing near any limit — and the third comes back 200 with
    // no id, so only three are attached.
    metaFetch
      .mockResolvedValueOnce(ok({ id: 'p1' }))
      .mockResolvedValueOnce(ok({ id: 'p2' }))
      .mockResolvedValueOnce(ok({})) // 200, no id
      .mockResolvedValueOnce(ok({ id: 'p4' }))
      .mockResolvedValueOnce(ok({ id: 'F1' }));

    const r = await publishToNetwork(fbAccount(), 'caption', images(4), {
      mediaMime: images(4).map(() => 'image/jpeg'),
    });

    expect(r.ok).toBe(true);
    expect(r.droppedMedia?.count).toBe(1);
    expect(r.droppedMedia?.reason).toContain('without returning a photo id');
    // No limit was hit and no video existed — neither may be blamed.
    expect(r.droppedMedia?.reason).not.toContain('ten photos');
    expect(r.droppedMedia?.reason).not.toContain('video');
  });

  it('Facebook multi-photo: the eleventh photo IS the ten-per-post shape, and says so', async () => {
    for (let i = 0; i < 10; i++) metaFetch.mockResolvedValueOnce(ok({ id: `p${i}` }));
    metaFetch.mockResolvedValueOnce(ok({ id: 'F1' }));

    const urls = images(12);
    const r = await publishToNetwork(fbAccount(), 'caption', urls, {
      mediaMime: urls.map(() => 'image/jpeg'),
    });

    expect(r.ok).toBe(true);
    expect(r.droppedMedia?.count).toBe(2);
    expect(r.droppedMedia?.reason).toContain('holds 10 photos');
    expect(r.droppedMedia?.reason).not.toContain('without returning a photo id');
    expect(r.droppedMedia?.reason).not.toContain('video');
  });

  it('Facebook single photo: one photo in, one photo out — nothing is reported as dropped', async () => {
    metaFetch.mockResolvedValueOnce(ok({ id: 'ph', post_id: 'P1' }));
    const r = await publishToNetwork(fbAccount(), 'caption', ['https://cdn.example/only.jpg'], {
      mediaMime: ['image/jpeg'],
    });
    expect(r.ok).toBe(true);
    expect(r.droppedMedia).toBeUndefined();
  });
});

/**
 * THE CAPACITY SENTENCE NAMES THE FORMAT WHEN THE NUMBER DEPENDS ON IT.
 *
 * A planner post set to INSTAGRAM REEL with three clips was told "INSTAGRAM
 * carries 1 video per post" — true at REEL, false at FEED, where it carries ten.
 * The operator who reads it moves the campaign off Instagram when the fix was to
 * publish the same three clips to the feed.
 */
describe('videoCapacityPhrase — the format is part of the fact', () => {
  const clips = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ url: `https://cdn.example/b${i + 1}.mp4`, mime: 'video/mp4' }));

  it('names the format on Instagram, whose capacity changes with it', () => {
    expect(selectMediaForTarget(clips(3), 'INSTAGRAM', 'REEL').dropped).toEqual({
      count: 2,
      reason: 'INSTAGRAM REEL carries 1 video per post',
    });
    expect(selectMediaForTarget(clips(3), 'INSTAGRAM', 'STORY').dropped?.reason).toBe(
      'INSTAGRAM STORY carries 1 video per post',
    );
    expect(selectMediaForTarget(clips(12), 'INSTAGRAM', 'FEED').dropped).toEqual({
      count: 2,
      reason: 'INSTAGRAM FEED carries 10 videos per post',
    });
  });

  it('leaves the format OUT where it changes nothing — no setting to go hunting for', () => {
    // Facebook is one video at every format; X is none at every format.
    expect(selectMediaForTarget(clips(3), 'FACEBOOK', 'REEL').dropped?.reason).toBe(
      'FACEBOOK carries 1 video per post',
    );
    expect(selectMediaForTarget(clips(3), 'TWITTER', 'FEED').dropped?.reason).toBe(
      'TWITTER cannot carry video at all',
    );
  });
});

/**
 * X, WHEN EVERY UPLOAD IS REFUSED — the answer depends on whose post it is.
 * Hand-composed words survive their picture; a post whose media was generated
 * FOR it does not become a caption.
 */
describe('publishTwitter — a generated post is its media', () => {
  it('refuses to tweet the caption alone when X refuses all the GENERATED media', async () => {
    safeFetch
      .mockResolvedValueOnce(imageBytes())
      .mockResolvedValueOnce(resp({ detail: 'unsupported media' })); // upload rejected

    const r = await publishToNetwork(xAccount(), 'caption', ['https://cdn.example/a.png'], {
      mediaMime: ['image/png'],
      mediaGeneratedForPost: true,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/generated/);
    // The tweet endpoint is never reached: nothing is published, nothing to delete.
    expect(safeFetch.mock.calls.some((c: any[]) => String(c[0]).includes('/2/tweets'))).toBe(false);
  });

  it('still tweets the words when the SAME failure happens to a hand-composed post', async () => {
    safeFetch
      .mockResolvedValueOnce(imageBytes())
      .mockResolvedValueOnce(resp({ detail: 'unsupported media' }))
      .mockResolvedValueOnce(resp({ data: { id: 'tweet-3' } }));

    const r = await publishToNetwork(xAccount(), 'caption', ['https://cdn.example/a.png'], {
      mediaMime: ['image/png'],
    });

    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('tweet-3');
    expect(r.droppedMedia?.reason).toContain('refused');
  });

  it('publishes a generated post that got SOME of its media up, and names the rest', async () => {
    safeFetch
      .mockResolvedValueOnce(imageBytes())
      .mockResolvedValueOnce(resp({ data: { id: 'm0' } })) // first uploads
      .mockResolvedValueOnce(imageBytes())
      .mockResolvedValueOnce(resp({ detail: 'unsupported media' })) // second refused
      .mockResolvedValueOnce(resp({ data: { id: 'tweet-4' } }));

    const r = await publishToNetwork(
      xAccount(),
      'caption',
      ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      { mediaMime: ['image/png', 'image/png'], mediaGeneratedForPost: true },
    );

    expect(r.ok).toBe(true);
    expect(r.droppedMedia).toEqual({ count: 1, reason: expect.stringContaining('refused') });
  });
});
