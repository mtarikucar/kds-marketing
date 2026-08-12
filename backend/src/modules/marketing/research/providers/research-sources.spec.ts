import { FirecrawlProvider } from './firecrawl.provider';
import { ApifyProvider } from './apify.provider';
import { ResearchSourcesService } from './research-sources.service';
import { NativeWebProvider } from './native-web.provider';

/** With no keys the whole research source layer must be provably inert. */
describe('Research source providers (env-gated)', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('reports disabled + returns inert results when NO key at all is set (incl. Anthropic)', async () => {
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.APIFY_TOKEN;
    delete process.env.ANTHROPIC_API_KEY; // native is off too → truly inert
    const fc = new FirecrawlProvider();
    const ap = new ApifyProvider();
    const sources = new ResearchSourcesService(fc, ap, new NativeWebProvider());

    expect(sources.isEnabled()).toBe(false);
    expect(sources.status()).toEqual({ firecrawl: false, apify: false, native: false, enabled: false });
    expect(await fc.scrape('https://example.com')).toBeNull();
    expect(await fc.searchWeb('coffee shops izmir')).toEqual([]);
    expect(await ap.searchPlaces({ query: 'kuaför', geo: { country: 'TR' }, limit: 10 })).toEqual([]);
    expect(await ap.lookupInstagram('@acme')).toBeNull();
  });

  it('is ENABLED by the native provider alone — the Anthropic key the platform already has', () => {
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.APIFY_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const sources = new ResearchSourcesService(new FirecrawlProvider(), new ApifyProvider(), new NativeWebProvider());
    // No scraping vendor bought, yet research is not inert: search + scrape run.
    expect(sources.isEnabled()).toBe(true);
    expect(sources.status()).toMatchObject({ firecrawl: false, apify: false, native: true });
  });

  it('reports enabled when a paid key is present', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    delete process.env.APIFY_TOKEN;
    const sources = new ResearchSourcesService(new FirecrawlProvider(), new ApifyProvider(), new NativeWebProvider());
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
