import { FirecrawlProvider } from './firecrawl.provider';
import { ApifyProvider } from './apify.provider';
import { ResearchSourcesService } from './research-sources.service';

/** With no keys the whole research source layer must be provably inert. */
describe('Research source providers (env-gated)', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('reports disabled + returns inert results when no keys are set', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.APIFY_TOKEN;
    const fc = new FirecrawlProvider();
    const ap = new ApifyProvider();
    const sources = new ResearchSourcesService(fc, ap);

    expect(sources.isEnabled()).toBe(false);
    expect(sources.status()).toEqual({ firecrawl: false, apify: false, enabled: false });
    expect(await fc.scrape('https://example.com')).toBeNull();
    expect(await fc.searchWeb('coffee shops izmir')).toEqual([]);
    expect(await ap.searchPlaces({ query: 'kuaför', geo: { country: 'TR' }, limit: 10 })).toEqual([]);
    expect(await ap.lookupInstagram('@acme')).toBeNull();
  });

  it('reports enabled when a key is present', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    delete process.env.APIFY_TOKEN;
    const sources = new ResearchSourcesService(new FirecrawlProvider(), new ApifyProvider());
    expect(sources.isEnabled()).toBe(true);
    expect(sources.status().firecrawl).toBe(true);
  });

  // A CONFIGURED provider whose call fails must THROW (not swallow to []/null):
  // the toolset meters the budget after each call, so a swallowed failure was
  // silently billed as a successful run.
  it('configured firecrawl THROWS on a failed HTTP call instead of returning null', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch' as never)
      .mockResolvedValue({ ok: false, status: 502 } as never);
    try {
      await expect(new FirecrawlProvider().scrape('https://x.example')).rejects.toThrow(/failed \(502\)/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('configured apify THROWS on a failed actor run instead of returning []', async () => {
    process.env.APIFY_TOKEN = 'ap-test';
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch' as never)
      .mockResolvedValue({ ok: false, status: 500 } as never);
    try {
      await expect(
        new ApifyProvider().searchPlaces({ query: 'kuaför', geo: { country: 'TR' }, limit: 5 }),
      ).rejects.toThrow(/failed \(500\)/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('searchPlaces tolerates a malformed persisted geo (string instead of array) without crashing', async () => {
    process.env.APIFY_TOKEN = 'ap-test';
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch' as never)
      .mockResolvedValue({ ok: true, json: async () => [] } as never);
    try {
      // Old raw-API rows could hold cities as a plain string — ".join is not a
      // function" used to kill the whole run while still consuming credits.
      const rows = await new ApifyProvider().searchPlaces({
        query: 'kuaför',
        geo: { country: 'TR', cities: 'İzmir' as unknown as string[] },
        limit: 5,
      });
      expect(rows).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
