import { Injectable, Logger } from '@nestjs/common';
import { ApifyProvider } from '../../research/providers/apify.provider';
import { BrandSource, BrandSourceInput, BrandSourceResult } from './brand-source';

/**
 * Scrapes the workspace's OWN social accounts via ApifyProvider.scrapeSocial(),
 * one call per handle in the EXPLICIT `socialHandles` input (the Task-15
 * wizard prefills these from connected accounts on the FE — the backend
 * adapter stays simple and unambiguous). Inert when Apify is unconfigured or
 * no handles were supplied. Per-handle failure is isolated: one bad handle
 * never fails the whole source. Does NOT meter — reports `apifyRuns` (only
 * calls that completed, i.e. no billable success on a throw) for the runner
 * (Task 12) to meter.
 */
@Injectable()
export class SocialBrandSource implements BrandSource {
  readonly source = 'social' as const;
  private readonly logger = new Logger(SocialBrandSource.name);
  constructor(private readonly apify: ApifyProvider) {}

  async collect(_workspaceId: string, input: BrandSourceInput): Promise<BrandSourceResult> {
    const handles = input.socialHandles ?? [];
    if (!this.apify.isConfigured() || !handles.length) {
      return { source: this.source, status: 'inert', raw: null };
    }
    const hits: unknown[] = [];
    let runs = 0;
    for (const h of handles) {
      try {
        const hit = await this.apify.scrapeSocial(h.network, h.handle);
        runs += 1; // count only calls that completed (throw = no billable success)
        if (hit) hits.push({ network: h.network, ...hit });
      } catch (e) {
        this.logger.warn(`social ${h.network}/${h.handle} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { source: this.source, status: 'ok', raw: hits, apifyRuns: runs };
  }
}
