import { ApifyTiktokTrendsProvider } from './apify-tiktok-trends.provider';

const originalFetch = global.fetch;
const fetchMock = jest.fn();
const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);

const ITEMS = [
  { hashtagName: 'sonbahar', videoCount: 120000, rank: 1 },
  { hashtag: '#okulaDönüş', publishCnt: 80000 },
  { soundName: 'Tarkan - Dudu', author: 'Tarkan', useCount: 50000, url: 'https://www.tiktok.com/music/1' },
  { type: 'sound', title: 'Trend beat', count: 10 },
  { title: '' },
  { hashtagName: 'sonbahar' }, // duplicate — second sighting is dropped
];

beforeEach(() => {
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  fetchMock.mockReset();
  delete process.env.APIFY_TOKEN;
  delete process.env.TREND_TIKTOK_ACTOR;
});
afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
});

describe('ApifyTiktokTrendsProvider', () => {
  it('is disabled until BOTH the token and the actor id are set, and fetch() is inert while disabled', async () => {
    const p = new ApifyTiktokTrendsProvider();
    expect(p.name).toBe('apify-tiktok');
    expect(p.enabled()).toBe(false);
    process.env.APIFY_TOKEN = 't';
    expect(p.enabled()).toBe(false);
    process.env.TREND_TIKTOK_ACTOR = 'someone~tiktok-trends';
    expect(p.enabled()).toBe(true);
    delete process.env.APIFY_TOKEN;
    expect(await p.fetch('TR')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs the actor synchronously with { region } and maps items to HASHTAG/SOUND candidates scored by rank', async () => {
    process.env.APIFY_TOKEN = 'tok';
    process.env.TREND_TIKTOK_ACTOR = 'someone~tiktok-trends';
    fetchMock.mockReturnValueOnce(json(ITEMS));
    const out = await new ApifyTiktokTrendsProvider().fetch('TR');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.apify.com/v2/acts/someone~tiktok-trends/run-sync-get-dataset-items?token=tok');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ region: 'TR' });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(out.map((c) => [c.kind, c.title, c.score])).toEqual([
      ['HASHTAG', 'sonbahar', 100],
      ['HASHTAG', 'okulaDönüş', 75],
      ['SOUND', 'Tarkan - Dudu', 50],
      ['SOUND', 'Trend beat', 25],
    ]);
    expect(out.every((c) => c.network === 'TIKTOK' && c.halfLifeHours === 48)).toBe(true);
    expect(out[2].ref).toBe('https://www.tiktok.com/music/1');
    expect(out[0].raw).toEqual(expect.objectContaining({ count: 120000 }));
  });

  it('treats a non-array body as no items and a non-2xx as a provider error', async () => {
    process.env.APIFY_TOKEN = 'tok';
    process.env.TREND_TIKTOK_ACTOR = 'a~b';
    fetchMock.mockReturnValueOnce(json({ error: 'x' }));
    expect(await new ApifyTiktokTrendsProvider().fetch('TR')).toEqual([]);
    fetchMock.mockReturnValueOnce(json({}, 402));
    await expect(new ApifyTiktokTrendsProvider().fetch('TR')).rejects.toThrow(/402/);
  });
});
