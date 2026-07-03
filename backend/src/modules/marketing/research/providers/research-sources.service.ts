import { Injectable } from '@nestjs/common';
import { FirecrawlProvider } from './firecrawl.provider';
import { ApifyProvider } from './apify.provider';

/**
 * Facade over the research source providers. `isEnabled()` drives the product's
 * honest "research not configured yet" state — the whole engine is inert (finds
 * nothing, spends nothing) until an operator sets FIRECRAWL_API_KEY and/or
 * APIFY_TOKEN.
 */
@Injectable()
export class ResearchSourcesService {
  constructor(
    readonly firecrawl: FirecrawlProvider,
    readonly apify: ApifyProvider,
  ) {}

  /** True when at least one source provider has credentials. */
  isEnabled(): boolean {
    return this.firecrawl.isConfigured() || this.apify.isConfigured();
  }

  status(): { firecrawl: boolean; apify: boolean; enabled: boolean } {
    return {
      firecrawl: this.firecrawl.isConfigured(),
      apify: this.apify.isConfigured(),
      enabled: this.isEnabled(),
    };
  }
}
