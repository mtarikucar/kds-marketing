/**
 * ads.service.ts — typed service layer for Meta Ads + TikTok Ads reporting
 * (GoHighLevel parity). Each workspace connects its OWN ad account; the access
 * token is sealed server-side and never returned. `spend` is in the account
 * currency's MAJOR unit (e.g. 12.34), unlike invoices/estimates which use minor
 * units — provider insights report spend in major units.
 */

import marketingApi from './marketingApi';

export type AdProvider = 'META' | 'TIKTOK' | 'LINKEDIN';
export type AdAccountStatus = 'ACTIVE' | 'TOKEN_EXPIRED' | 'DISCONNECTED';

export interface AdProviderStatus {
  META: boolean;
  TIKTOK: boolean;
  LINKEDIN: boolean;
  secretBoxConfigured: boolean;
}

export interface AdAccount {
  id: string;
  provider: AdProvider;
  externalAdId: string;
  displayName: string;
  status: AdAccountStatus;
  currency: string | null;
  lastPulledAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface ConnectAdAccountPayload {
  provider: AdProvider;
  externalAdId: string;
  displayName?: string;
  accessToken: string;
  currency?: string;
}

/** A single bucket of aggregated metrics (major-unit spend). */
export interface AdMetricBucket {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
}

export interface AdMetricsResponse {
  totals: AdMetricBucket;
  byProvider: Partial<Record<AdProvider, AdMetricBucket>>;
  byDay: Array<AdMetricBucket & { date: string }>;
}

export interface AdMetricsQuery {
  from?: string;
  to?: string;
  provider?: AdProvider;
}

export const getAdStatus = (): Promise<AdProviderStatus> =>
  marketingApi.get('/ads/status').then((r) => r.data);

export const listAdAccounts = (): Promise<AdAccount[]> =>
  marketingApi.get('/ads/accounts').then((r) => r.data);

export const getAdMetrics = (q: AdMetricsQuery = {}): Promise<AdMetricsResponse> =>
  marketingApi.get('/ads/metrics', { params: q }).then((r) => r.data);

export const connectAdAccount = (payload: ConnectAdAccountPayload): Promise<AdAccount> =>
  marketingApi.post('/ads/accounts', payload).then((r) => r.data);

export const removeAdAccount = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/ads/accounts/${id}`).then((r) => r.data);

export const pullAdAccount = (id: string, days?: number): Promise<{ written: number }> =>
  marketingApi.post(`/ads/accounts/${id}/pull`, days ? { days } : {}).then((r) => r.data);

// ── LinkedIn for Business (ads) OAuth ───────────────────────────────────────

export interface LinkedinAdsPendingAccount {
  externalAdId: string;
  displayName: string;
  currency: string | null;
}

export interface LinkedinAdsPending {
  accounts: LinkedinAdsPendingAccount[];
}

export interface LinkedinAdsConfirmResult {
  connected: number;
}

/** POST /ads/oauth/linkedin/start → { authorizeUrl } */
export const startLinkedinAdsOAuth = (): Promise<{ authorizeUrl: string }> =>
  marketingApi.post('/ads/oauth/linkedin/start').then((r) => r.data);

/** GET /ads/oauth/linkedin/pending/:id */
export const getLinkedinAdsPending = (id: string): Promise<LinkedinAdsPending> =>
  marketingApi.get(`/ads/oauth/linkedin/pending/${id}`).then((r) => r.data);

/** POST /ads/oauth/linkedin/pending/:id/confirm */
export const confirmLinkedinAdsPending = (
  id: string,
  selected: string[],
): Promise<LinkedinAdsConfirmResult> =>
  marketingApi.post(`/ads/oauth/linkedin/pending/${id}/confirm`, { selected }).then((r) => r.data);
