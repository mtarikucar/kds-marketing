import { dispatchResearchTool } from './research-toolset';

/**
 * The RESEARCH budget must be metered ONLY for provider calls that actually
 * ran. Two legs previously billed without work: a not-configured provider
 * (inert []/null) and a failed HTTP call (the providers used to swallow to
 * []/null). Both must skip the meter; success must meter exactly once.
 */
describe('dispatchResearchTool — meter only on provider success', () => {
  const ctx = { workspaceId: 'ws1', runId: 'run1', geo: { country: 'TR' }, budgetId: null };

  function makeDeps(overrides: Partial<{ apifyConfigured: boolean; firecrawlConfigured: boolean }> = {}) {
    const sources = {
      apify: {
        isConfigured: jest.fn().mockReturnValue(overrides.apifyConfigured ?? true),
        searchPlaces: jest.fn().mockResolvedValue([{ name: 'Cafe X' }]),
        lookupInstagram: jest.fn().mockResolvedValue(null),
      },
      firecrawl: {
        isConfigured: jest.fn().mockReturnValue(overrides.firecrawlConfigured ?? true),
        scrape: jest.fn().mockResolvedValue({ markdown: 'hi', meta: {} }),
        searchWeb: jest.fn().mockResolvedValue([]),
      },
    };
    const spend = { settle: jest.fn().mockResolvedValue(null) };
    const runs = { recordTool: jest.fn().mockResolvedValue(undefined) };
    return { deps: { sources, spend, runs } as any, sources, spend, runs };
  }

  it('meters an APIFY_RUN when search_places succeeds', async () => {
    const { deps, spend } = makeDeps();
    const res = await dispatchResearchTool(deps, ctx, 'search_places', { query: 'kuaför' });
    expect(res).toEqual([{ name: 'Cafe X' }]);
    expect(spend.settle).toHaveBeenCalledWith('ws1', expect.objectContaining({ unit: 'APIFY_RUN', quantity: 1 }));
  });

  it('does NOT meter when the provider is not configured — returns a clear error for the model', async () => {
    const { deps, sources, spend, runs } = makeDeps({ apifyConfigured: false });
    const res = await dispatchResearchTool(deps, ctx, 'search_places', { query: 'kuaför' });
    expect(sources.apify.searchPlaces).not.toHaveBeenCalled();
    expect(spend.settle).not.toHaveBeenCalled();
    expect(res).toEqual({ error: expect.stringContaining('not configured') });
    expect(runs.recordTool).toHaveBeenCalledWith('ws1', 'run1', expect.objectContaining({ ok: false }));
  });

  it('does NOT meter when the provider call throws (HTTP/network failure)', async () => {
    const { deps, sources, spend } = makeDeps();
    sources.firecrawl.scrape.mockRejectedValue(new Error('firecrawl /v1/scrape failed (502)'));
    const res = await dispatchResearchTool(deps, ctx, 'scrape_page', { url: 'https://x.example' });
    expect(spend.settle).not.toHaveBeenCalled();
    expect(res).toEqual({ error: 'firecrawl /v1/scrape failed (502)' });
  });

  it('a legitimately-empty successful result IS metered (the provider did run)', async () => {
    const { deps, sources, spend } = makeDeps();
    sources.firecrawl.searchWeb.mockResolvedValue([]);
    await dispatchResearchTool(deps, ctx, 'search_web', { query: 'x' });
    expect(spend.settle).toHaveBeenCalledWith('ws1', expect.objectContaining({ unit: 'FIRECRAWL_PAGE' }));
  });
});
