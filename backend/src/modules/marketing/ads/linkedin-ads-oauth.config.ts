/**
 * Pure configuration helpers for the LinkedIn-for-Business (ads) OAuth flow.
 * These are NOT NestJS providers — plain functions imported where needed.
 * CRITICAL BOUNDARY: this is the ADS app (LINKEDIN_ADS_CLIENT_ID/SECRET),
 * completely separate from the social-planner app (LINKEDIN_CLIENT_ID/SECRET).
 * Confidential client → authorization-code WITHOUT PKCE.
 */
import { isLinkedinAdsConfigured } from './ads.types';

export { isLinkedinAdsConfigured };

export const LINKEDIN_ADS_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_ADS_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

/** Reporting + read scopes for the Marketing (ads) API. Space-delimited. */
// rw_ads + rw_dmp_segments enable the campaign-write + DMP-audience-sync clients;
// they require partner approval on the LinkedIn app, so accounts (re)connected
// after that approval carry write scope (read-only ones keep working meanwhile).
export const LINKEDIN_ADS_SCOPES = 'r_ads_reporting r_ads rw_ads rw_dmp_segments';

export function linkedinAdsRedirectUri(): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/marketing/ads/oauth/linkedin/callback`;
}

export function buildLinkedinAdsAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINKEDIN_ADS_CLIENT_ID ?? '',
    redirect_uri: linkedinAdsRedirectUri(),
    state,
  });
  // Append scope separately and percent-encode the space as %20 (URLSearchParams
  // would encode it as '+'); LinkedIn accepts both, but %20 is the canonical form.
  return `${LINKEDIN_ADS_AUTHORIZE_URL}?${params.toString()}&scope=${encodeURIComponent(
    LINKEDIN_ADS_SCOPES,
  )}`;
}
