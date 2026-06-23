import { safeFetch } from '../../../common/util/safe-fetch';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { isNetworkConfigured, publishToNetwork, AccountRow } from './network-adapters';

jest.mock('../../../common/util/safe-fetch');
jest.mock('../../../common/crypto/secret-box.helper');
const mockedFetch = safeFetch as jest.MockedFunction<typeof safeFetch>;
(openSecret as jest.Mock).mockReturnValue('plain-token');

const resp = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response);
const account: AccountRow = { id: 'a', network: 'TIKTOK', externalId: 'tt1', accessToken: 'sealed', accountType: 'TIKTOK' };

describe('network-adapters — TikTok', () => {
  const KEY = process.env.TIKTOK_CLIENT_KEY;
  const SECRET = process.env.TIKTOK_CLIENT_SECRET;

  beforeAll(() => {
    process.env.TIKTOK_CLIENT_KEY = 'k';
    process.env.TIKTOK_CLIENT_SECRET = 's';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (KEY === undefined) delete process.env.TIKTOK_CLIENT_KEY;
    else process.env.TIKTOK_CLIENT_KEY = KEY;
    if (SECRET === undefined) delete process.env.TIKTOK_CLIENT_SECRET;
    else process.env.TIKTOK_CLIENT_SECRET = SECRET;
  });

  it('isNetworkConfigured(TIKTOK) reflects the TIKTOK_CLIENT_* env vars', () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    expect(isNetworkConfigured('TIKTOK')).toBe(false);
    process.env.TIKTOK_CLIENT_KEY = 'k';
    process.env.TIKTOK_CLIENT_SECRET = 's';
    expect(isNetworkConfigured('TIKTOK')).toBe(true);
  });

  it('dispatches TIKTOK and is inert (no network call) when not configured', async () => {
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
    const res = await publishToNetwork(account, 'hello', ['https://cdn.example/v.mp4']);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('TikTok not configured');
    process.env.TIKTOK_CLIENT_KEY = 'k';
    process.env.TIKTOK_CLIENT_SECRET = 's';
  });

  it('passes per-post privacy + interaction options into the video init body', async () => {
    // creator_info -> video init -> status poll complete
    mockedFetch
      .mockResolvedValueOnce(resp({ data: { privacy_level_options: ['PUBLIC_TO_EVERYONE'], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 300 } }))
      .mockResolvedValueOnce(resp({ data: { publish_id: 'pub1' } }))
      .mockResolvedValueOnce(resp({ data: { status: 'PUBLISH_COMPLETE' } }));

    const res = await publishToNetwork(account, 'hello', ['https://cdn/v.mp4'], {
      tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE', disableComment: true, disableDuet: true },
    });

    expect(res.ok).toBe(true);
    expect(res.externalPostId).toBe('pub1');
    const initCall = mockedFetch.mock.calls[1];
    const body = JSON.parse((initCall[1] as any).body);
    expect(body.post_info.privacy_level).toBe('PUBLIC_TO_EVERYONE');
    expect(body.post_info.disable_comment).toBe(true);
    expect(body.post_info.disable_duet).toBe(true);
    expect(body.source_info.source).toBe('PULL_FROM_URL');
  });

  it('routes a PHOTO post to the content/init endpoint with photo_images', async () => {
    mockedFetch
      .mockResolvedValueOnce(resp({ data: { privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 0 } }))
      .mockResolvedValueOnce(resp({ data: { publish_id: 'pub2' } }))
      .mockResolvedValueOnce(resp({ data: { status: 'PUBLISH_COMPLETE' } }));

    const res = await publishToNetwork(account, 'pics', ['https://cdn/1.jpg', 'https://cdn/2.jpg'], {
      tiktok: { mediaType: 'PHOTO', coverIndex: 1 },
    });

    expect(res.ok).toBe(true);
    const initCall = mockedFetch.mock.calls[1];
    expect(initCall[0]).toContain('/v2/post/publish/content/init/');
    const body = JSON.parse((initCall[1] as any).body);
    expect(body.media_type).toBe('PHOTO');
    // TikTok requires photo_images / photo_cover_index under source_info.
    expect(body.source_info.source).toBe('PULL_FROM_URL');
    expect(body.source_info.photo_images).toEqual(['https://cdn/1.jpg', 'https://cdn/2.jpg']);
    expect(body.source_info.photo_cover_index).toBe(1);
    // Video-only interaction fields must NOT leak into a photo post.
    expect(body.post_info.disable_duet).toBeUndefined();
    expect(body.post_info.disable_stitch).toBeUndefined();
  });

  it('clips an unavailable privacy level to the creator-info option set', async () => {
    mockedFetch
      .mockResolvedValueOnce(resp({ data: { privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 60 } }))
      .mockResolvedValueOnce(resp({ data: { publish_id: 'pub3' } }))
      .mockResolvedValueOnce(resp({ data: { status: 'PUBLISH_COMPLETE' } }));
    await publishToNetwork(account, 'x', ['https://cdn/v.mp4'], { tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE' } });
    const body = JSON.parse((mockedFetch.mock.calls[1][1] as any).body);
    expect(body.post_info.privacy_level).toBe('SELF_ONLY'); // clipped
  });
});
