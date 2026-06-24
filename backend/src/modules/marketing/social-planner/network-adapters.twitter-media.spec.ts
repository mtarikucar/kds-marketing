import * as fetchMod from '../../../common/util/safe-fetch';
import { sealSecret } from '../../../common/crypto/secret-box.helper';
import { publishToNetwork } from './network-adapters';

jest.mock('../../../common/util/safe-fetch');
const mockFetch = fetchMod.safeFetch as jest.Mock;

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

function imageResponse(bytes = 1024): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(bytes),
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
  } as unknown as Response;
}
function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body, headers: { get: () => null } } as unknown as Response;
}

/**
 * X/Twitter image media — publishTwitter now uploads up to 4 images to the v2
 * media endpoint and attaches their ids to the tweet; an upload failure degrades
 * to a text-only tweet rather than failing the whole post.
 */
describe('publishTwitter — image media (X v2 media upload)', () => {
  beforeAll(() => { process.env.MARKETING_SECRET_KEY = MASTER_KEY; });
  afterAll(() => { delete process.env.MARKETING_SECRET_KEY; });

  beforeEach(() => {
    process.env.X_CLIENT_ID = 'xid';
    process.env.X_CLIENT_SECRET = 'xsecret';
    mockFetch.mockReset();
  });
  afterEach(() => {
    delete process.env.X_CLIENT_ID;
    delete process.env.X_CLIENT_SECRET;
  });

  const account = () => ({ id: 'a', network: 'TWITTER', externalId: 'u1', accessToken: sealSecret('TOKEN') }) as any;

  it('uploads the image and attaches its media id to the tweet', async () => {
    mockFetch
      .mockResolvedValueOnce(imageResponse()) // fetch the image bytes
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'media-1' } })) // media upload
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'tweet-9' } })); // create tweet

    const r = await publishToNetwork(account(), 'hello', ['https://cdn.example.com/a.png']);
    expect(r.ok).toBe(true);
    expect(r.externalPostId).toBe('tweet-9');

    // The third call is the tweet create; its body carries the media id.
    const tweetCall = mockFetch.mock.calls[2];
    expect(tweetCall[0]).toBe('https://api.twitter.com/2/tweets');
    const body = JSON.parse(tweetCall[1].body as string);
    expect(body.media).toEqual({ media_ids: ['media-1'] });
    expect(body.text).toBe('hello');
  });

  it('degrades to a text-only tweet when the media upload fails', async () => {
    mockFetch
      .mockResolvedValueOnce(imageResponse())
      .mockResolvedValueOnce(jsonResponse({ detail: 'unsupported' }, false)) // upload fails
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'tweet-10' } }));

    const r = await publishToNetwork(account(), 'hello', ['https://cdn.example.com/a.png']);
    expect(r.ok).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[2][1].body as string);
    expect(body.media).toBeUndefined(); // no media attached
    expect(body.text).toBe('hello');
  });

  it('caps uploads at 4 images even when more are supplied', async () => {
    // 4 image fetches + 4 uploads + 1 tweet = 9 calls.
    for (let i = 0; i < 4; i++) {
      mockFetch
        .mockResolvedValueOnce(imageResponse())
        .mockResolvedValueOnce(jsonResponse({ data: { id: `m${i}` } }));
    }
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'tweet-11' } }));

    const urls = Array.from({ length: 6 }, (_, i) => `https://cdn.example.com/${i}.png`);
    const r = await publishToNetwork(account(), 'hi', urls);
    expect(r.ok).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[8][1].body as string);
    expect(body.media.media_ids).toEqual(['m0', 'm1', 'm2', 'm3']);
  });
});
