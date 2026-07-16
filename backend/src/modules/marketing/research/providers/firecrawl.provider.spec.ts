import { FirecrawlProvider } from './firecrawl.provider';

/** Mirrors the fetch-mock idiom in research-sources.spec.ts. */
describe('FirecrawlProvider.crawl', () => {
  beforeEach(() => {
    delete process.env.FIRECRAWL_API_KEY;
    jest.restoreAllMocks();
  });

  it('unconfigured: resolves [] and never calls fetch', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as never);
    const result = await new FirecrawlProvider().crawl('https://x.com', { limit: 5 });
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('configured: maps the site then scrapes up to `limit` pages, root first', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    jest
      .spyOn(globalThis, 'fetch' as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ links: ['https://x.com', 'https://x.com/about', 'https://x.com/p'] }),
      } as never)
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: { markdown: '# page' } }),
      } as never);

    const pages = await new FirecrawlProvider().crawl('https://x.com', { limit: 2 });
    expect(pages).toEqual([
      { url: 'https://x.com', markdown: '# page' },
      { url: 'https://x.com/about', markdown: '# page' },
    ]);
  });

  it('configured, one scrape 404s: that page is skipped, others still returned, no rejection', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    jest
      .spyOn(globalThis, 'fetch' as never)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ links: ['https://x.com', 'https://x.com/about', 'https://x.com/p'] }),
      } as never) // /v1/map
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markdown: '# root' } }),
      } as never) // scrape root
      .mockResolvedValueOnce({ ok: false, status: 404 } as never) // scrape about → 404
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markdown: '# p' } }),
      } as never); // scrape p

    const pages = await new FirecrawlProvider().crawl('https://x.com', { limit: 5 });
    expect(pages).toEqual([
      { url: 'https://x.com', markdown: '# root' },
      { url: 'https://x.com/p', markdown: '# p' },
    ]);
  });

  it('map itself failing falls back to just the root page (map throws internally, crawl catches)', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test';
    jest
      .spyOn(globalThis, 'fetch' as never)
      .mockResolvedValueOnce({ ok: false, status: 500 } as never) // /v1/map fails
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: { markdown: '# root' } }),
      } as never); // scrape root

    const pages = await new FirecrawlProvider().crawl('https://x.com', { limit: 5 });
    expect(pages).toEqual([{ url: 'https://x.com', markdown: '# root' }]);
  });
});
