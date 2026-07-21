import { Injectable, Logger } from '@nestjs/common';
import { ScrapeResult, WebHit } from './research-source.provider';

const FIRECRAWL_BASE = process.env.FIRECRAWL_BASE_URL ?? 'https://api.firecrawl.dev';
const FIRECRAWL_TIMEOUT_MS = Number(process.env.FIRECRAWL_TIMEOUT_MS ?? 30_000);

/**
 * Firecrawl REST provider (scrape a page to markdown + web search). Inert until
 * FIRECRAWL_API_KEY is set (mirrors FalProvider). Firecrawl fetches the target
 * URLs on its side, so we only ever call the fixed api.firecrawl.dev host — no
 * SSRF surface here. Each returned page/search is one billable unit the caller
 * meters into the RESEARCH budget.
 */
@Injectable()
export class FirecrawlProvider {
  readonly name = 'firecrawl';
  private readonly logger = new Logger(FirecrawlProvider.name);

  isConfigured(): boolean {
    return !!process.env.FIRECRAWL_API_KEY;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' };
  }

  /** No-key stays inert (null), but a CONFIGURED provider whose call fails
   *  THROWS instead of swallowing to null — the toolset meters the RESEARCH
   *  budget after each call, so a swallowed failure was silently billed as a
   *  successful page (and an outage turned into "no results" for the model). */
  private async post<T>(path: string, body: unknown): Promise<T | null> {
    if (!this.isConfigured()) return null;
    let res: Response;
    try {
      res = await fetch(`${FIRECRAWL_BASE}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
      });
    } catch (e) {
      this.logger.warn(`firecrawl ${path} error: ${e instanceof Error ? e.message : e}`);
      throw new Error(`firecrawl ${path} unreachable: ${e instanceof Error ? e.message : 'network error'}`);
    }
    if (!res.ok) {
      this.logger.warn(`firecrawl ${path} failed (${res.status})`);
      throw new Error(`firecrawl ${path} failed (${res.status})`);
    }
    return (await res.json()) as T;
  }

  /** Scrape one URL to markdown. Null when disabled; throws on a failed call. */
  async scrape(url: string): Promise<ScrapeResult | null> {
    const body = (await this.post<{ data?: { markdown?: string; metadata?: Record<string, unknown> } }>(
      '/v1/scrape',
      { url, formats: ['markdown'], onlyMainContent: true },
    )) ?? null;
    if (!body?.data) return null;
    return { markdown: (body.data.markdown ?? '').slice(0, 20_000), meta: body.data.metadata ?? {} };
  }

  /** Web search (query → result list). Returns [] when disabled. */
  async searchWeb(query: string, limit = 8): Promise<WebHit[]> {
    const body = await this.post<{ data?: Array<{ url?: string; title?: string; description?: string }> }>(
      '/v1/search',
      { query, limit: Math.min(Math.max(limit, 1), 20) },
    );
    if (!body?.data) return [];
    return body.data
      .filter((r) => !!r.url)
      .map((r) => ({ url: r.url as string, title: r.title, description: r.description }));
  }

  /** Crawl a site to markdown: map its URLs, then scrape a bounded, brand-relevant
   *  subset. Returns [] when disabled. The map call throws on a real outage (per
   *  the provider convention); individual page 404s are normal crawl attrition —
   *  they're skipped, and only successfully-scraped pages are returned (hence only
   *  they get metered), so the no-false-billing intent is preserved. */
  async crawl(rootUrl: string, opts: { limit: number }): Promise<Array<{ url: string; markdown: string }>> {
    if (!this.isConfigured()) return [];
    const limit = Math.min(Math.max(opts.limit, 1), 20);
    let links: string[] = [];
    try {
      const mapped = await this.post<{ links?: string[]; data?: string[] }>('/v1/map', { url: rootUrl });
      links = mapped?.links ?? mapped?.data ?? [];
    } catch (e) {
      this.logger.warn(`firecrawl map failed for ${rootUrl}: ${e instanceof Error ? e.message : e}`);
      links = []; // fall back to just the root page below
    }
    // Prioritise the root + brand-relevant pages (about / products / services /
    // pricing), in TR + EN, then fill with the rest. Dedupe, bound to `limit`.
    const RELEVANT = /(about|hakk|product|urun|ürün|service|hizmet|pricing|fiyat|menu|corporate|kurumsal)/i;
    const ordered = [rootUrl, ...links.filter((u) => RELEVANT.test(u)), ...links];
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const u of ordered) {
      if (typeof u !== 'string' || seen.has(u)) continue;
      seen.add(u);
      targets.push(u);
      if (targets.length >= limit) break;
    }
    const pages: Array<{ url: string; markdown: string }> = [];
    for (const u of targets) {
      try {
        const r = await this.scrape(u);
        if (r?.markdown) pages.push({ url: u, markdown: r.markdown });
      } catch (e) {
        this.logger.warn(`firecrawl scrape skipped ${u}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return pages;
  }
}
