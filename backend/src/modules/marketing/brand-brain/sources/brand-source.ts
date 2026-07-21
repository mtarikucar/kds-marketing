/**
 * Shared interface + types for the Brand Brain source adapters (Task 10).
 *
 * Each adapter gathers a workspace's OWN materials from one source (website,
 * social, Google Business Profile, uploads) on top of the Task-9 provider
 * fetchers (FirecrawlProvider / ApifyProvider / R2StorageService). Adapters
 * are PURE COLLECTORS: they never throw (a caught failure becomes
 * `status:'error'`) and they do NOT meter — they only report the billable
 * unit counts (`firecrawlPages` / `apifyRuns`) they consumed so the runner
 * (Task 12) can meter them into the RESEARCH budget, mirroring the pattern
 * where the toolset — not the provider — meters.
 */

export interface BrandSourceInput {
  websiteUrl?: string;
  socialHandles?: Array<{ network: 'INSTAGRAM' | 'FACEBOOK' | 'LINKEDIN'; handle: string }>;
  gbpQuery?: string; // the workspace's OWN business name / GBP URL
  uploadKeys?: string[]; // R2 object keys already uploaded by the wizard
}

export interface BrandSourceResult {
  source: 'website' | 'social' | 'gbp' | 'uploads';
  status: 'ok' | 'inert' | 'error';
  raw: unknown;
  error?: string;
  firecrawlPages?: number; // billable FIRECRAWL_PAGE units the runner should meter
  apifyRuns?: number; // billable APIFY_RUN units the runner should meter
}

export interface BrandSource {
  readonly source: BrandSourceResult['source'];
  collect(workspaceId: string, input: BrandSourceInput): Promise<BrandSourceResult>;
}
