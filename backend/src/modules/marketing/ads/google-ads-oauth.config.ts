/**
 * Pure configuration helpers for the Google Ads OAuth flow. These are NOT NestJS
 * providers — plain functions imported where needed (mirrors
 * linkedin-ads-oauth.config). Confidential client → authorization-code WITHOUT
 * PKCE, with `access_type=offline` + `prompt=consent` so Google returns a
 * long-lived REFRESH token (Google only returns it on the first consent unless
 * prompt=consent is forced) — that refresh token is what the account seals and
 * the client mints per-call access tokens from.
 */
import { isGoogleAdsConfigured } from './ads.types';

export { isGoogleAdsConfigured };

export const GOOGLE_ADS_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_ADS_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The single scope the Google Ads API needs. */
export const GOOGLE_ADS_SCOPES = 'https://www.googleapis.com/auth/adwords';

export function googleAdsRedirectUri(): string {
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/api/marketing/ads/oauth/google/callback`;
}

export function buildGoogleAdsAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.GOOGLE_ADS_CLIENT_ID ?? '',
    redirect_uri: googleAdsRedirectUri(),
    scope: GOOGLE_ADS_SCOPES,
    // offline + forced consent → guarantees a refresh_token on the exchange.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_ADS_AUTHORIZE_URL}?${params.toString()}`;
}
