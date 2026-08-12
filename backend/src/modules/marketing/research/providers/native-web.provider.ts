import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { ScrapeResult, WebHit } from './research-source.provider';

const MODEL = process.env.NATIVE_RESEARCH_MODEL ?? 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = Number(process.env.NATIVE_RESEARCH_TIMEOUT_MS ?? 45_000);

/**
 * The keyless research fallback: Anthropic's own `web_search` and `web_fetch`
 * SERVER tools, driven by the ANTHROPIC_API_KEY the platform already pays for.
 *
 * Why this exists: the whole research engine used to be inert without a
 * Firecrawl/Apify key — a brand-new workspace could never find a prospect, and
 * the intake site-crawl silently read nothing (which is how the first customer
 * strategy misread the product). This provider makes the SEARCH and SCRAPE
 * slots work with NO new vendor and NO new npm dependency: server tools run
 * inside Anthropic, so there is no SSRF surface and no browser to host.
 *
 * It is the FALLBACK, not the default — the toolset prefers Firecrawl when a
 * key is set (deterministic SERP shape, cheaper per call at volume) and reaches
 * for this only when Firecrawl is unconfigured or down. Cost here is Anthropic
 * tokens + the metered web_search price, bounded by `maxUses` and a cheap model.
 */
@Injectable()
export class NativeWebProvider {
  readonly name = 'native';
  private readonly logger = new Logger(NativeWebProvider.name);
  private client: Anthropic | null = null;

  /** Always available when the platform's own Anthropic key is present — this
   *  is what stops the research engine from being fully inert on a workspace
   *  that never bought a scraping vendor. */
  isConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  private getClient(): Anthropic | null {
    if (!this.isConfigured()) return null;
    if (!this.client) this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return this.client;
  }

  /**
   * Web search → the top hits as {url,title}. The model is instructed to search
   * once and stop; `max_uses: 1` on the server tool is the hard bound so a
   * chatty turn cannot fan out into many billed searches. TR is passed as the
   * user location so Turkish-language, Turkey-local results rank first.
   */
  async searchWeb(query: string, limit = 8): Promise<WebHit[]> {
    const client = this.getClient();
    if (!client || !query.trim()) return [];
    let res: Anthropic.Message;
    try {
      res = await client.messages.create(
        {
          model: MODEL,
          max_tokens: 1024,
          tools: [
            {
              type: 'web_search_20260209',
              name: 'web_search',
              max_uses: 1,
              // The model invokes the tool directly. Without this, models that
              // don't support programmatic (code-execution) tool calling — the
              // cheap tier we use here — 400 with "does not support
              // programmatic tool calling".
              allowed_callers: ['direct'],
              user_location: { type: 'approximate', country: 'TR' },
            } as unknown as Anthropic.ToolUnion,
          ],
          messages: [
            {
              role: 'user',
              content:
                `Use the web_search tool exactly once to find: ${query}\n` +
                'Then stop. Do not summarise — the search results themselves are what I need.',
            },
          ],
        },
        { timeout: TIMEOUT_MS },
      );
    } catch (e) {
      this.logger.warn(`native web_search failed: ${e instanceof Error ? e.message : e}`);
      throw new Error(`native web_search failed: ${e instanceof Error ? e.message : 'error'}`);
    }
    const hits: WebHit[] = [];
    for (const block of res.content) {
      if (block.type !== 'web_search_tool_result') continue;
      const content = (block as { content?: unknown }).content;
      if (!Array.isArray(content)) continue; // an error block, not results
      for (const r of content) {
        const row = r as { type?: string; url?: string; title?: string };
        if (row.type === 'web_search_result' && typeof row.url === 'string') {
          hits.push({ url: row.url, title: row.title });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }

  /**
   * Fetch one URL → its text as markdown-ish content. `allowed_domains` is
   * pinned to the requested host so the model cannot be steered into fetching
   * some other site, and `max_uses: 1` bounds it to the single page asked for.
   */
  async scrape(url: string): Promise<ScrapeResult | null> {
    const client = this.getClient();
    if (!client || !url.trim()) return null;
    const host = this.hostOf(url);
    if (!host) return null;
    let res: Anthropic.Message;
    try {
      res = await client.messages.create(
        {
          model: MODEL,
          max_tokens: 2048,
          tools: [
            {
              type: 'web_fetch_20260209',
              name: 'web_fetch',
              max_uses: 1,
              // Same as web_search: direct model invocation, required by the
              // cheap model tier.
              allowed_callers: ['direct'],
              allowed_domains: [host],
              // Bound the fetched document so a huge page cannot blow the turn.
              max_content_tokens: 8000,
            } as unknown as Anthropic.ToolUnion,
          ],
          messages: [
            {
              role: 'user',
              content: `Use the web_fetch tool exactly once to fetch ${url} and then stop.`,
            },
          ],
        },
        { timeout: TIMEOUT_MS },
      );
    } catch (e) {
      this.logger.warn(`native web_fetch failed: ${e instanceof Error ? e.message : e}`);
      throw new Error(`native web_fetch failed: ${e instanceof Error ? e.message : 'error'}`);
    }
    for (const block of res.content) {
      if (block.type !== 'web_fetch_tool_result') continue;
      const inner = (block as { content?: { type?: string; content?: unknown } }).content;
      if (!inner || inner.type !== 'web_fetch_result') continue; // error block
      const doc = (inner as { content?: unknown }).content as
        | { type?: string; source?: { data?: string; media_type?: string } }
        | undefined;
      const markdown = this.textOf(doc);
      if (markdown) return { markdown, meta: { url, source: 'anthropic-web_fetch' } };
    }
    return null;
  }

  /** The document Anthropic returns is a `document` block whose source carries
   *  the extracted text; be defensive about the exact shape across tool
   *  versions. */
  private textOf(doc: unknown): string {
    if (!doc || typeof doc !== 'object') return '';
    const d = doc as { source?: { data?: string; text?: string; content?: unknown }; text?: string };
    if (typeof d.text === 'string') return d.text;
    const src = d.source;
    if (src) {
      if (typeof src.text === 'string') return src.text;
      if (typeof src.data === 'string') return src.data;
      if (typeof src.content === 'string') return src.content;
    }
    return '';
  }

  private hostOf(url: string): string | null {
    try {
      return new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    } catch {
      return null;
    }
  }
}
