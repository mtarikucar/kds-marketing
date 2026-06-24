/**
 * Pure configuration helpers for the TikTok-for-Business OAuth flow (ads module).
 * These are NOT NestJS providers — they are plain functions imported where needed.
 * CRITICAL BOUNDARY: this file is part of the ads module, not the social-planner.
 */

export function isTiktokBusinessConfigured(): boolean {
  return !!(process.env.TIKTOK_BUSINESS_APP_ID && process.env.TIKTOK_BUSINESS_APP_SECRET);
}

export function tiktokBusinessRedirectUri(): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/marketing/ads/oauth/tiktok/callback`;
}

export function buildTiktokBusinessAuthorizeUrl(state: string): string {
  const appId = process.env.TIKTOK_BUSINESS_APP_ID ?? '';
  const redirectUri = tiktokBusinessRedirectUri();
  const params = new URLSearchParams({
    app_id: appId,
    state,
    redirect_uri: redirectUri,
  });
  return `https://business-api.tiktok.com/portal/auth?${params.toString()}`;
}
