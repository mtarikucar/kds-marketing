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
});
