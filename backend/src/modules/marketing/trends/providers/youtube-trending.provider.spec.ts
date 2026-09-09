import { YoutubeTrendingProvider } from './youtube-trending.provider';

const originalFetch = global.fetch;
const fetchMock = jest.fn();
const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);

const BODY = {
  items: [
    { id: 'abc123', snippet: { title: 'Yeni kahve makinesi incelemesi', channelTitle: 'Kanal', categoryId: '26', tags: ['kahve'] }, statistics: { viewCount: '999990' } },
    { id: 'def456', snippet: { title: '  Müzik   klibi ' }, statistics: {} },
    { id: 'ghi789', snippet: { title: '' }, statistics: { viewCount: '5' } },
  ],
};

beforeEach(() => {
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  fetchMock.mockReset();
  delete process.env.YOUTUBE_API_KEY;
});
afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
});

describe('YoutubeTrendingProvider', () => {
  it('is disabled without YOUTUBE_API_KEY and inert while disabled', async () => {
    const p = new YoutubeTrendingProvider();
    expect(p.name).toBe('youtube-trending');
    expect(p.enabled()).toBe(false);
    expect(await p.fetch('TR')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.YOUTUBE_API_KEY = 'k';
    expect(p.enabled()).toBe(true);
  });

  it('calls videos.mostPopular for the region and maps videos to TOPIC candidates with a log view score', async () => {
    process.env.YOUTUBE_API_KEY = 'key-1';
    fetchMock.mockReturnValueOnce(json(BODY));
    const out = await new YoutubeTrendingProvider().fetch('TR');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/youtube/v3/videos?part=snippet%2Cstatistics&chart=mostPopular&regionCode=TR&maxResults=25&key=key-1');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      network: 'YOUTUBE', kind: 'TOPIC', title: 'Yeni kahve makinesi incelemesi', ref: 'https://www.youtube.com/watch?v=abc123',
      score: expect.closeTo(60, 3), halfLifeHours: 72,
      raw: expect.objectContaining({ videoId: 'abc123', viewCount: 999990, channelTitle: 'Kanal', tags: ['kahve'] }),
    });
    expect(out[1]).toEqual(expect.objectContaining({ title: 'Müzik klibi', score: 10 }));
  });

  it('surfaces a quota/auth failure as a thrown error', async () => {
    process.env.YOUTUBE_API_KEY = 'key-1';
    fetchMock.mockReturnValueOnce(json({ error: { message: 'quotaExceeded' } }, 403));
    await expect(new YoutubeTrendingProvider().fetch('TR')).rejects.toThrow(/403/);
  });
});
