import { Injectable, Logger } from '@nestjs/common';
import { ApifyProvider } from '../../research/providers/apify.provider';
import { BrandSource, BrandSourceInput, BrandSourceResult } from './brand-source';

/**
 * Looks up the workspace's OWN Google Business Profile via
 * ApifyProvider.scrapeGoogleBusiness(). Inert when Apify is unconfigured or
 * no gbpQuery was supplied. Never throws: a lookup failure becomes
 * `status:'error'`. Does NOT meter — reports `apifyRuns` for the runner
 * (Task 12) to meter.
 */
@Injectable()
export class GbpBrandSource implements BrandSource {
  readonly source = 'gbp' as const;
  private readonly logger = new Logger(GbpBrandSource.name);
  constructor(private readonly apify: ApifyProvider) {}

  async collect(_workspaceId: string, input: BrandSourceInput): Promise<BrandSourceResult> {
    if (!this.apify.isConfigured() || !input.gbpQuery) {
      return { source: this.source, status: 'inert', raw: null };
    }
    try {
      const place = await this.apify.scrapeGoogleBusiness(input.gbpQuery);
      return { source: this.source, status: 'ok', raw: place, apifyRuns: 1 };
    } catch (e) {
      this.logger.warn(`gbp source failed: ${e instanceof Error ? e.message : e}`);
      return {
        source: this.source,
        status: 'error',
        raw: null,
        error: e instanceof Error ? e.message : 'gbp failed',
      };
    }
  }
}
