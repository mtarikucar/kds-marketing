/** A normalized per-day (optionally per-campaign) ad metric row from a provider. */
export interface AdMetricRow {
  date: string; // YYYY-MM-DD
  campaignId: string; // '' = account-level
  spend: number; // account-currency major units
  impressions: number;
  clicks: number;
  leads: number;
  raw?: unknown;
}

export function isMetaAdsConfigured(): boolean {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
}
export function isTiktokAdsConfigured(): boolean {
  return !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}
