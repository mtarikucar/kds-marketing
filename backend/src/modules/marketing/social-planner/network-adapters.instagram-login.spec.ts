import * as fetchMod from '../../../common/util/safe-fetch';
import { sealSecret } from '../../../common/crypto/secret-box.helper';
import { isNetworkConfigured, publishToNetwork } from './network-adapters';

jest.mock('../../../common/util/safe-fetch');
const safeFetch = fetchMod.safeFetch as jest.Mock;

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const res = (body: any, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body }) as any;

const igAccount = () =>
  ({ id: 'a', network: 'INSTAGRAM_LOGIN', externalId: 'IGD123', accessToken: sealSecret('TOK') }) as any;

const urlOf = (n: number) => safeFetch.mock.calls[n][0] as string;
const bodyOf = (n: number) => JSON.parse(safeFetch.mock.calls[n][1]?.body ?? '{}');

beforeAll(() => {
  process.env.MARKETING_SECRET_KEY = MASTER_KEY;
  process.env.INSTAGRAM_APP_ID = 'igapp';
  process.env.INSTAGRAM_APP_SECRET = 'igsecret';
});
afterAll(() => {
  delete process.env.MARKETING_SECRET_KEY;
  delete process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_SECRET;
});
beforeEach(() => safeFetch.mockReset());

describe('network-adapters — Instagram (direct Login)', () => {
  it('isNetworkConfigured reflects INSTAGRAM_APP_* and the publish is inert without creds', async () => {
    delete process.env.INSTAGRAM_APP_ID;
    delete process.env.INSTAGRAM_APP_SECRET;
    expect(isNetworkConfigured('INSTAGRAM_LOGIN')).toBe(false);
    const r = await publishToNetwork(igAccount(), 'hi', ['https://cdn/a.jpg']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Instagram (Login) not configured');
    expect(safeFetch).not.toHaveBeenCalled();
    process.env.INSTAGRAM_APP_ID = 'igapp';
    process.env.INSTAGRAM_APP_SECRET = 'igsecret';
    expect(isNetworkConfigured('INSTAGRAM_LOGIN')).toBe(true);
  });

  it('image → container(image_url) then media_publish on graph.instagram.com', async () => {
    safeFetch
      .mockResolvedValueOnce(res({ id: 'creation-1' })) // create container
      .mockResolvedValueOnce(res({ id: 'POST-1' })); // media_publish
    const r = await publishToNetwork(igAccount(), 'caption', ['https://cdn/a.jpg']);
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('POST-1');
    // container
    expect(urlOf(0)).toBe('https://graph.instagram.com/IGD123/media');
    expect(bodyOf(0)).toMatchObject({ image_url: 'https://cdn/a.jpg', caption: 'caption' });
    expect(bodyOf(0).media_type).toBeUndefined();
    // publish
    expect(urlOf(1)).toBe('https://graph.instagram.com/IGD123/media_publish');
    expect(bodyOf(1)).toMatchObject({ creation_id: 'creation-1' });
    // exactly 2 calls — no status poll for images
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it('video → container(REELS) + poll FINISHED + media_publish', async () => {
    safeFetch
      .mockResolvedValueOnce(res({ id: 'creation-2' })) // create REELS container
      .mockResolvedValueOnce(res({ status_code: 'FINISHED' })) // poll
      .mockResolvedValueOnce(res({ id: 'POST-2' })); // media_publish
    const r = await publishToNetwork(igAccount(), 'reel', ['https://cdn/v.mp4']);
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('POST-2');
    expect(urlOf(0)).toBe('https://graph.instagram.com/IGD123/media');
    expect(bodyOf(0)).toMatchObject({ media_type: 'REELS', video_url: 'https://cdn/v.mp4', caption: 'reel' });
    // poll hits the container id
    expect(urlOf(1)).toContain('https://graph.instagram.com/creation-2?');
    expect(urlOf(1)).toContain('fields=status_code');
    // publish
    expect(urlOf(2)).toBe('https://graph.instagram.com/IGD123/media_publish');
    expect(bodyOf(2)).toMatchObject({ creation_id: 'creation-2' });
  });

  it('video processing ERROR aborts before publishing', async () => {
    safeFetch
      .mockResolvedValueOnce(res({ id: 'creation-3' }))
      .mockResolvedValueOnce(res({ status_code: 'ERROR' }));
    const r = await publishToNetwork(igAccount(), 'reel', ['https://cdn/v.mov']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('IG processing ERROR');
    // no media_publish call
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces a container-creation failure', async () => {
    safeFetch.mockResolvedValueOnce(res({ error: { message: 'bad media url' } }, false));
    const r = await publishToNetwork(igAccount(), 'x', ['https://cdn/a.jpg']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('IG container: bad media url');
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('requires at least one media item', async () => {
    const r = await publishToNetwork(igAccount(), 'no media', []);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('at least one media item');
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
