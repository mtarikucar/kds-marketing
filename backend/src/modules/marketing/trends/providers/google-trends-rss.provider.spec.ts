import { GoogleTrendsRssProvider } from './google-trends-rss.provider';

const originalFetch = global.fetch;
const fetchMock = jest.fn();
const text = (body: string, status = 200) => Promise.resolve({ ok: status < 400, status, text: async () => body } as Response);

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel><title>Daily Search Trends</title>
<item><title>Galatasaray Fenerbahçe</title><ht:approx_traffic>20.000+</ht:approx_traffic><pubDate>Mon, 07 Sep 2026 10:00:00 -0700</pubDate>
  <ht:news_item><ht:news_item_title>Derbi</ht:news_item_title><ht:news_item_url>https://example.com/derbi</ht:news_item_url></ht:news_item>
  <ht:news_item><ht:news_item_title>Other</ht:news_item_title><ht:news_item_url>https://example.com/other</ht:news_item_url></ht:news_item>
</item>
<item><title><![CDATA[Kahve &amp; süt]]></title><ht:approx_traffic>500+</ht:approx_traffic></item>
<item><title>   </title><ht:approx_traffic>1.000+</ht:approx_traffic></item>
</channel></rss>`;

beforeEach(() => {
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  fetchMock.mockReset();
  delete process.env.TREND_GOOGLE_DISABLED;
});
afterAll(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
});

describe('GoogleTrendsRssProvider', () => {
  it('is enabled without any key and disabled by TREND_GOOGLE_DISABLED=1', () => {
    const p = new GoogleTrendsRssProvider();
    expect(p.name).toBe('google-trends');
    expect(p.enabled()).toBe(true);
    process.env.TREND_GOOGLE_DISABLED = '1';
    expect(p.enabled()).toBe(false);
  });

  it('fetches the geo feed and maps items to TOPIC candidates on GOOGLE with a log traffic score', async () => {
    fetchMock.mockReturnValueOnce(text(RSS));
    const out = await new GoogleTrendsRssProvider().fetch('TR');
    expect(fetchMock.mock.calls[0][0]).toBe('https://trends.google.com/trending/rss?geo=TR');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(out).toHaveLength(2); // the blank title is dropped
    expect(out[0]).toEqual({
      network: 'GOOGLE', kind: 'TOPIC', title: 'Galatasaray Fenerbahçe', ref: 'https://example.com/derbi',
      score: expect.closeTo(Math.log10(20010) * 10, 6), halfLifeHours: 36,
      raw: expect.objectContaining({ traffic: 20000, approxTraffic: '20.000+' }),
    });
    expect(out[1].title).toBe('Kahve & süt');
    expect(out[1].ref).toBeUndefined();
    expect(out[1].score).toBeCloseTo(Math.log10(510) * 10, 6);
  });

  it('clips the score into 0..100 and treats missing traffic as 0', async () => {
    fetchMock.mockReturnValueOnce(text('<rss><channel><item><title>x</title><ht:approx_traffic>99.999.999.999+</ht:approx_traffic></item><item><title>y</title></item></channel></rss>'));
    const out = await new GoogleTrendsRssProvider().fetch('TR');
    expect(out.map((c) => c.score)).toEqual([100, 10]);
  });

  it('throws on a non-2xx so the service can record the error against this provider only', async () => {
    fetchMock.mockReturnValueOnce(text('nope', 503));
    await expect(new GoogleTrendsRssProvider().fetch('TR')).rejects.toThrow(/503/);
  });
});
