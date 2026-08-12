import { dispatchResearchTool } from './research-toolset';

/**
 * The RESEARCH budget must be metered ONLY for provider calls that actually
 * ran. Two legs previously billed without work: a not-configured provider
 * (inert []/null) and a failed HTTP call (the providers used to swallow to
 * []/null). Both must skip the meter; success must meter exactly once.
 */
describe('dispatchResearchTool — meter only on provider success', () => {
  const ctx = { workspaceId: 'ws1', runId: 'run1', geo: { country: 'TR' }, budgetId: null };

  function makeDeps(overrides: Partial<{ apifyConfigured: boolean; firecrawlConfigured: boolean; nativeConfigured: boolean }> = {}) {
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
      native: {
        isConfigured: jest.fn().mockReturnValue(overrides.nativeConfigured ?? true),
        scrape: jest.fn().mockResolvedValue({ markdown: 'native page', meta: {} }),
        searchWeb: jest.fn().mockResolvedValue([{ url: 'https://n.example', title: 'n' }]),
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

  it('does NOT meter when the provider call throws and there is no fallback', async () => {
    // native OFF, so a firecrawl throw has nowhere to fall back to — the
    // original contract: surface the error, never meter a failed call.
    const { deps, sources, spend } = makeDeps({ nativeConfigured: false });
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

  /**
   * The native fallback (Anthropic web_search/web_fetch, platform key) covers the
   * SEARCH and SCRAPE slots when no Firecrawl key exists — so research is never
   * fully inert. Firecrawl still WINS the slot when configured.
   */
  describe('dispatchResearchTool — native fallback for search/scrape', () => {
    const ctx = { workspaceId: 'ws1', runId: 'run1', geo: { country: 'TR' }, budgetId: null };
  
    it('falls back to native scrape when firecrawl is not configured', async () => {
      const { deps, sources, spend } = makeDeps({ firecrawlConfigured: false });
      const res = await dispatchResearchTool(deps, ctx, 'scrape_page', { url: 'https://acme.example' });
      expect(sources.firecrawl.scrape).not.toHaveBeenCalled();
      expect(sources.native.scrape).toHaveBeenCalledWith('https://acme.example');
      expect(res).toEqual({ markdown: 'native page', meta: {} });
      expect(spend.settle).toHaveBeenCalledWith('ws1', expect.objectContaining({ unit: 'FIRECRAWL_PAGE' }));
    });
  
    it('falls back to native search when firecrawl is not configured', async () => {
      const { deps, sources } = makeDeps({ firecrawlConfigured: false });
      const res = await dispatchResearchTool(deps, ctx, 'search_web', { query: 'etkinlik ajansı istanbul' });
      expect(sources.firecrawl.searchWeb).not.toHaveBeenCalled();
      expect(sources.native.searchWeb).toHaveBeenCalled();
      expect(res).toEqual([{ url: 'https://n.example', title: 'n' }]);
    });
  
    it('PREFERS firecrawl for scrape when both are configured', async () => {
      const { deps, sources } = makeDeps();
      await dispatchResearchTool(deps, ctx, 'scrape_page', { url: 'https://acme.example' });
      expect(sources.firecrawl.scrape).toHaveBeenCalled();
      expect(sources.native.scrape).not.toHaveBeenCalled();
    });
  
    it('errors (no meter) when neither firecrawl nor native can scrape', async () => {
      const { deps, sources, spend } = makeDeps({ firecrawlConfigured: false, nativeConfigured: false });
      const res = await dispatchResearchTool(deps, ctx, 'scrape_page', { url: 'https://acme.example' });
      expect(sources.native.scrape).not.toHaveBeenCalled();
      expect((res as { error?: string }).error).toBeTruthy();
      expect(spend.settle).not.toHaveBeenCalled();
    });
  });

  /**
   * The fallback must trigger on a configured-but-FAILING primary, not only a
   * missing key. A Firecrawl key with no credits 402s on every call — "configured"
   * yet useless — and the pipeline has to reach native for it. This is the exact
   * live case that kept figurunica finding zero prospects after the keys were set.
   */
  describe('dispatchResearchTool — fallback on a THROWING primary', () => {
    const ctx = { workspaceId: 'ws1', runId: 'run1', geo: { country: 'TR' }, budgetId: null };
  
    it('falls back to native scrape when a CONFIGURED firecrawl throws (out of credits)', async () => {
      const { deps, sources, spend } = makeDeps(); // both configured
      sources.firecrawl.scrape.mockRejectedValue(new Error('firecrawl /v1/scrape failed (402)'));
  
      const res = await dispatchResearchTool(deps, ctx, 'scrape_page', { url: 'https://acme.example' });
  
      expect(sources.firecrawl.scrape).toHaveBeenCalled();
      expect(sources.native.scrape).toHaveBeenCalledWith('https://acme.example');
      expect(res).toEqual({ markdown: 'native page', meta: {} });
      // Metered once, for the call that actually succeeded.
      expect(spend.settle).toHaveBeenCalledTimes(1);
    });
  
    it('falls back to native search when a CONFIGURED firecrawl search throws', async () => {
      const { deps, sources } = makeDeps();
      sources.firecrawl.searchWeb.mockRejectedValue(new Error('firecrawl /v1/search failed (402)'));
  
      const res = await dispatchResearchTool(deps, ctx, 'search_web', { query: 'etkinlik ajansı' });
  
      expect(sources.native.searchWeb).toHaveBeenCalled();
      expect(res).toEqual([{ url: 'https://n.example', title: 'n' }]);
    });
  
    it('propagates the failure (no meter) when firecrawl throws AND native is unconfigured', async () => {
      const { deps, sources, spend } = makeDeps({ nativeConfigured: false });
      sources.firecrawl.scrape.mockRejectedValue(new Error('firecrawl /v1/scrape failed (500)'));
  
      const res = await dispatchResearchTool(deps, ctx, 'scrape_page', { url: 'https://acme.example' });
  
      expect((res as { error?: string }).error).toMatch(/500/);
      expect(spend.settle).not.toHaveBeenCalled();
    });
  });
});
