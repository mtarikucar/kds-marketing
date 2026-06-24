import * as metaUtil from '../../../common/util/meta-graph.util';
import * as fetchMod from '../../../common/util/safe-fetch';
import { sealSecret } from '../../../common/crypto/secret-box.helper';
import { publishToNetwork } from './network-adapters';

jest.mock('../../../common/util/meta-graph.util', () => ({
  metaGraphFetch: jest.fn(),
}));
jest.mock('../../../common/util/safe-fetch');

const metaFetch = metaUtil.metaGraphFetch as jest.Mock;
const safeFetch = fetchMod.safeFetch as jest.Mock;

const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

const ok = (data: any) => ({ ok: true, status: 200, data, error: null });
const fail = (message: string, isAuthError = false) => ({
  ok: false,
  status: 400,
  data: {},
  error: { httpStatus: 400, code: null, subcode: null, fbtraceId: null, message, isAuthError },
});

const igAccount = () =>
  ({ id: 'a', network: 'INSTAGRAM', externalId: 'IG123', accessToken: sealSecret('TOK') }) as any;
const fbAccount = () =>
  ({ id: 'b', network: 'FACEBOOK', externalId: 'PAGE9', accessToken: sealSecret('TOK') }) as any;

/** Body of the Nth metaGraphFetch call. */
const bodyOf = (n: number) => metaFetch.mock.calls[n][1]?.body ?? {};
const pathOf = (n: number) => metaFetch.mock.calls[n][0];
const queryOf = (n: number) => metaFetch.mock.calls[n][1]?.query ?? {};

beforeAll(() => {
  process.env.MARKETING_SECRET_KEY = MASTER_KEY;
  process.env.META_APP_ID = 'app';
  process.env.META_APP_SECRET = 'secret';
});
afterAll(() => {
  delete process.env.MARKETING_SECRET_KEY;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
});
beforeEach(() => {
  metaFetch.mockReset();
  safeFetch.mockReset();
});

describe('Instagram adapter', () => {
  it('FEED single image → container(IMAGE) then publish', async () => {
    metaFetch.mockResolvedValueOnce(ok({ id: 'c1' })).mockResolvedValueOnce(ok({ id: 'IG_1' }));
    const r = await publishToNetwork(igAccount(), 'hi', ['https://cdn/a.jpg'], { format: 'FEED' });
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('IG_1');
    expect(pathOf(0)).toBe('/IG123/media');
    expect(bodyOf(0)).toMatchObject({ image_url: 'https://cdn/a.jpg', caption: 'hi' });
    expect(pathOf(1)).toBe('/IG123/media_publish');
    expect(bodyOf(1)).toMatchObject({ creation_id: 'c1' });
  });

  it('FEED single video is published as a Reel (status-polled)', async () => {
    metaFetch
      .mockResolvedValueOnce(ok({ id: 'c2' })) // create REELS
      .mockResolvedValueOnce(ok({ status_code: 'FINISHED' })) // poll
      .mockResolvedValueOnce(ok({ id: 'IG_V' })); // publish
    const r = await publishToNetwork(igAccount(), 'cap', ['https://cdn/v.mp4'], {
      format: 'FEED',
      mediaMime: ['video/mp4'],
    });
    expect(r.ok).toBe(true);
    expect(bodyOf(0)).toMatchObject({ media_type: 'REELS', video_url: 'https://cdn/v.mp4', share_to_feed: true });
  });

  it('REEL requires a video', async () => {
    const r = await publishToNetwork(igAccount(), 'x', ['https://cdn/a.jpg'], {
      format: 'REEL',
      mediaMime: ['image/jpeg'],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Reels requires a video/);
    expect(metaFetch).not.toHaveBeenCalled();
  });

  it('STORY image → container(STORIES) then publish', async () => {
    metaFetch.mockResolvedValueOnce(ok({ id: 'cs' })).mockResolvedValueOnce(ok({ id: 'IG_S' }));
    const r = await publishToNetwork(igAccount(), '', ['https://cdn/s.jpg'], {
      format: 'STORY',
      mediaMime: ['image/jpeg'],
    });
    expect(r.ok).toBe(true);
    expect(bodyOf(0)).toMatchObject({ media_type: 'STORIES', image_url: 'https://cdn/s.jpg' });
  });

  it('FEED 2 images → carousel (children + parent + publish)', async () => {
    metaFetch
      .mockResolvedValueOnce(ok({ id: 'ch1' }))
      .mockResolvedValueOnce(ok({ id: 'ch2' }))
      .mockResolvedValueOnce(ok({ id: 'cp' })) // parent CAROUSEL
      .mockResolvedValueOnce(ok({ status_code: 'FINISHED' })) // poll parent
      .mockResolvedValueOnce(ok({ id: 'IG_C' }));
    const r = await publishToNetwork(igAccount(), 'multi', ['https://cdn/1.jpg', 'https://cdn/2.jpg'], {
      format: 'FEED',
    });
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('IG_C');
    expect(bodyOf(0)).toMatchObject({ is_carousel_item: true });
    expect(bodyOf(2)).toMatchObject({ media_type: 'CAROUSEL', children: 'ch1,ch2' });
  });

  it('surfaces a container auth error', async () => {
    metaFetch.mockResolvedValueOnce(fail('Bad token', true));
    const r = await publishToNetwork(igAccount(), 'x', ['https://cdn/a.jpg'], { format: 'FEED' });
    expect(r.ok).toBe(false);
    expect(r.isAuthError).toBe(true);
  });
});

describe('Facebook adapter', () => {
  it('FEED single image → /photos with caption', async () => {
    metaFetch.mockResolvedValueOnce(ok({ id: 'ph', post_id: 'P1' }));
    const r = await publishToNetwork(fbAccount(), 'cap', ['https://cdn/a.jpg'], { format: 'FEED' });
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('P1');
    expect(pathOf(0)).toBe('/PAGE9/photos');
    expect(bodyOf(0)).toMatchObject({ url: 'https://cdn/a.jpg', caption: 'cap' });
  });

  it('FEED single video → /videos with file_url', async () => {
    metaFetch.mockResolvedValueOnce(ok({ id: 'V1' }));
    const r = await publishToNetwork(fbAccount(), 'd', ['https://cdn/v.mp4'], {
      format: 'FEED',
      mediaMime: ['video/mp4'],
    });
    expect(r.ok).toBe(true);
    expect(pathOf(0)).toBe('/PAGE9/videos');
    expect(bodyOf(0)).toMatchObject({ file_url: 'https://cdn/v.mp4', description: 'd' });
  });

  it('FEED multi-photo → unpublished uploads then attached_media feed', async () => {
    metaFetch
      .mockResolvedValueOnce(ok({ id: 'p1' }))
      .mockResolvedValueOnce(ok({ id: 'p2' }))
      .mockResolvedValueOnce(ok({ id: 'F1' }));
    const r = await publishToNetwork(fbAccount(), 'm', ['https://cdn/1.jpg', 'https://cdn/2.jpg'], {
      format: 'FEED',
    });
    expect(r.ok).toBe(true);
    expect(bodyOf(0)).toMatchObject({ published: false });
    expect(pathOf(2)).toBe('/PAGE9/feed');
    expect(bodyOf(2)).toMatchObject({ attached_media: [{ media_fbid: 'p1' }, { media_fbid: 'p2' }] });
  });

  it('REEL → start → upload-by-url → finish', async () => {
    metaFetch
      .mockResolvedValueOnce(ok({ video_id: 'vr1', upload_url: 'https://rupload/x' })) // start
      .mockResolvedValueOnce(ok({})); // finish
    safeFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
    const r = await publishToNetwork(fbAccount(), 'reel', ['https://cdn/v.mp4'], {
      format: 'REEL',
      mediaMime: ['video/mp4'],
    });
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('vr1');
    expect(queryOf(0)).toMatchObject({ upload_phase: 'start' });
    // upload pulls from the public URL
    expect(safeFetch.mock.calls[0][0]).toBe('https://rupload/x');
    expect(safeFetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'OAuth TOK',
      file_url: 'https://cdn/v.mp4',
    });
    expect(queryOf(1)).toMatchObject({ upload_phase: 'finish', video_id: 'vr1', video_state: 'PUBLISHED' });
  });

  it('STORY photo → unpublished photo then /photo_stories', async () => {
    metaFetch
      .mockResolvedValueOnce(ok({ id: 'ph1' }))
      .mockResolvedValueOnce(ok({ post_id: 'S1' }));
    const r = await publishToNetwork(fbAccount(), '', ['https://cdn/s.jpg'], {
      format: 'STORY',
      mediaMime: ['image/jpeg'],
    });
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('S1');
    expect(pathOf(0)).toBe('/PAGE9/photos');
    expect(bodyOf(0)).toMatchObject({ published: false });
    expect(pathOf(1)).toBe('/PAGE9/photo_stories');
    expect(bodyOf(1)).toMatchObject({ photo_id: 'ph1' });
  });

  it('FEED with no media → plain text feed post', async () => {
    metaFetch.mockResolvedValueOnce(ok({ id: 'T1' }));
    const r = await publishToNetwork(fbAccount(), 'just text', [], { format: 'FEED' });
    expect(r.ok).toBe(true);
    expect(pathOf(0)).toBe('/PAGE9/feed');
    expect(bodyOf(0)).toMatchObject({ message: 'just text' });
  });
});
