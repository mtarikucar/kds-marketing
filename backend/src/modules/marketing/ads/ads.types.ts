/** A normalized per-day (optionally per-campaign) ad metric row from a provider. */
export interface AdMetricRow {
  date: string; // YYYY-MM-DD
  campaignId: string; // '' = account-level
  spend: number; // account-currency major units
  impressions: number;
  clicks: number;
  leads: number;
  /** Provider-reported purchase value (deduplicated), 0 when absent (D10 cold-start). */
  conversionValue?: number;
  raw?: unknown;
}

export function isMetaAdsConfigured(): boolean {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
}
/**
 * TikTok ads uses the TikTok-for-Business platform credentials (not the
 * social-planner TIKTOK_CLIENT_KEY/SECRET which are for the organic API).
 */
export function isTiktokAdsConfigured(): boolean {
  return !!(process.env.TIKTOK_BUSINESS_APP_ID && process.env.TIKTOK_BUSINESS_APP_SECRET);
}
export function isLinkedinAdsConfigured(): boolean {
  return !!(process.env.LINKEDIN_ADS_CLIENT_ID && process.env.LINKEDIN_ADS_CLIENT_SECRET);
}
