import { WebsiteBrandSource } from './website.source';

function makeSvc(firecrawl: Partial<{ isConfigured: () => boolean; crawl: jest.Mock }>) {
  const provider: any = { isConfigured: () => true, crawl: jest.fn(), ...firecrawl };
  return { svc: new WebsiteBrandSource(provider), provider };
}

describe('WebsiteBrandSource', () => {
  it('inert when Firecrawl is unconfigured — never calls crawl', async () => {
    const { svc, provider } = makeSvc({ isConfigured: () => false });
    const result = await svc.collect('ws-1', { websiteUrl: 'https://acme.example' });
    expect(result).toEqual({ source: 'website', status: 'inert', raw: null });
    expect(provider.crawl).not.toHaveBeenCalled();
  });

  it('inert when websiteUrl is missing (even if configured) — never calls crawl', async () => {
    const { svc, provider } = makeSvc({ isConfigured: () => true });
    const result = await svc.collect('ws-1', {});
    expect(result).toEqual({ source: 'website', status: 'inert', raw: null });
    expect(provider.crawl).not.toHaveBeenCalled();
  });

  it('ok: returns crawled pages and the page count as firecrawlPages', async () => {
    const pages = [
      { url: 'https://acme.example', markdown: 'home' },
      { url: 'https://acme.example/about', markdown: 'about us' },
    ];
    const { svc, provider } = makeSvc({ isConfigured: () => true, crawl: jest.fn().mockResolvedValue(pages) });
    const result = await svc.collect('ws-1', { websiteUrl: 'https://acme.example' });
    expect(result).toEqual({ source: 'website', status: 'ok', raw: pages, firecrawlPages: 2 });
    expect(provider.crawl).toHaveBeenCalledWith('https://acme.example', { limit: 8 });
  });

  it('error isolation: a throwing crawl() resolves status:error instead of rejecting', async () => {
    const { svc } = makeSvc({ isConfigured: () => true, crawl: jest.fn().mockRejectedValue(new Error('outage')) });
    const result = await svc.collect('ws-1', { websiteUrl: 'https://acme.example' });
    expect(result.status).toBe('error');
    expect(result.raw).toBeNull();
    expect(result.error).toBe('outage');
  });
});
