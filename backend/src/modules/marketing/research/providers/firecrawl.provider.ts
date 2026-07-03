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

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    if (!this.isConfigured()) return null;
    try {
      const res = await fetch(`${FIRECRAWL_BASE}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`firecrawl ${path} failed (${res.status})`);
        return null;
      }
      return (await res.json()) as T;
    } catch (e) {
      this.logger.warn(`firecrawl ${path} error: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Scrape one URL to markdown. Returns null when disabled or on failure. */
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
}
