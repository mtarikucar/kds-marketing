import { Injectable } from '@nestjs/common';
import { FirecrawlProvider } from './firecrawl.provider';
import { ApifyProvider } from './apify.provider';
import { NativeWebProvider } from './native-web.provider';

/**
 * Facade over the research source providers.
 *
 * `isEnabled()` used to gate the WHOLE engine on a Firecrawl/Apify key, so a
 * workspace that never bought a scraping vendor found nothing — ever. That is
 * no longer the honest state: the native provider (Anthropic web_search /
 * web_fetch on the platform's own key) covers the SEARCH and SCRAPE slots with
 * no new vendor, so research is enabled whenever ANY source can run. The paid
 * providers still WIN their slots when configured — native is the fallback.
 * PLACES and SOCIAL remain Apify-only; without it those two tools return
 * "not configured", but search + scrape carry the pipeline on their own.
 */
@Injectable()
export class ResearchSourcesService {
  constructor(
    readonly firecrawl: FirecrawlProvider,
    readonly apify: ApifyProvider,
    readonly native: NativeWebProvider,
  ) {}

  /** True when at least one source — paid OR native — can run. */
  isEnabled(): boolean {
    return this.firecrawl.isConfigured() || this.apify.isConfigured() || this.native.isConfigured();
  }

  status(): { firecrawl: boolean; apify: boolean; native: boolean; enabled: boolean } {
    return {
      firecrawl: this.firecrawl.isConfigured(),
      apify: this.apify.isConfigured(),
      native: this.native.isConfigured(),
      enabled: this.isEnabled(),
    };
  }
}
