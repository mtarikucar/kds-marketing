import { Injectable, Logger } from '@nestjs/common';
import { FirecrawlProvider } from '../../research/providers/firecrawl.provider';
import { BrandSource, BrandSourceInput, BrandSourceResult } from './brand-source';

/**
 * Crawls the workspace's OWN website via FirecrawlProvider.crawl(). Inert
 * when Firecrawl is unconfigured or no websiteUrl was supplied — no fetch
 * attempted. Never throws: a crawl failure becomes `status:'error'`. Does
 * NOT meter — reports `firecrawlPages` for the runner (Task 12) to meter.
 */
@Injectable()
export class WebsiteBrandSource implements BrandSource {
  readonly source = 'website' as const;
  private readonly logger = new Logger(WebsiteBrandSource.name);
  constructor(private readonly firecrawl: FirecrawlProvider) {}

  async collect(_workspaceId: string, input: BrandSourceInput): Promise<BrandSourceResult> {
    if (!this.firecrawl.isConfigured() || !input.websiteUrl) {
      return { source: this.source, status: 'inert', raw: null };
    }
    try {
      const pages = await this.firecrawl.crawl(input.websiteUrl, { limit: 8 });
      return { source: this.source, status: 'ok', raw: pages, firecrawlPages: pages.length };
    } catch (e) {
      this.logger.warn(`website source failed: ${e instanceof Error ? e.message : e}`);
      return {
        source: this.source,
        status: 'error',
        raw: null,
        error: e instanceof Error ? e.message : 'crawl failed',
      };
    }
  }
}
