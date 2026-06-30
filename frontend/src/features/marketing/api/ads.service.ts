/**
 * ads.service.ts — typed service layer for Meta Ads + TikTok Ads reporting
 * (GoHighLevel parity). Each workspace connects its OWN ad account; the access
 * token is sealed server-side and never returned. `spend` is in the account
 * currency's MAJOR unit (e.g. 12.34), unlike invoices/estimates which use minor
 * units — provider insights report spend in major units.
 */

import marketingApi from './marketingApi';

export type AdProvider = 'META' | 'TIKTOK';
export type AdAccountStatus = 'ACTIVE' | 'TOKEN_EXPIRED' | 'DISCONNECTED';

export interface AdProviderStatus {
  META: boolean;
  TIKTOK: boolean;
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

// ── TikTok for Business OAuth ───────────────────────────────────────────────

export interface TiktokAdsPendingAdvertiser {
  externalAdId: string;
  displayName: string;
  currency: string;
}

export interface TiktokAdsPending {
  advertisers: TiktokAdsPendingAdvertiser[];
  messaging: boolean;
}

export interface TiktokAdsConfirmPayload {
  selected: string[];
  enableMessaging?: boolean;
}

export interface TiktokAdsConfirmResult {
  connectedAdAccounts: number;
  dmChannel: boolean;
}

/** POST /ads/oauth/tiktok/start → { authorizeUrl } */
export const startTiktokAdsOAuth = (): Promise<{ authorizeUrl: string }> =>
  marketingApi.post('/ads/oauth/tiktok/start').then((r) => r.data);

/** GET /ads/oauth/tiktok/pending/:id */
export const getTiktokAdsPending = (id: string): Promise<TiktokAdsPending> =>
  marketingApi.get(`/ads/oauth/tiktok/pending/${id}`).then((r) => r.data);

/** POST /ads/oauth/tiktok/pending/:id/confirm */
export const confirmTiktokAdsPending = (
  id: string,
  payload: TiktokAdsConfirmPayload,
): Promise<TiktokAdsConfirmResult> =>
  marketingApi.post(`/ads/oauth/tiktok/pending/${id}/confirm`, payload).then((r) => r.data);

// ── Campaign / ad set management (Meta only) ─────────────────────────────────
// Budgets are MAJOR currency units (e.g. 12.34), number or null.

export type AdEntityStatus = 'ACTIVE' | 'PAUSED';

export interface AdCampaign {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
}

export interface AdSet extends AdCampaign {
  campaignId: string;
}

export const listCampaigns = (accountId: string): Promise<AdCampaign[]> =>
  marketingApi.get(`/ads/accounts/${accountId}/campaigns`).then((r) => r.data);

export const listAdSets = (accountId: string, campaignId?: string): Promise<AdSet[]> =>
  marketingApi
    .get(`/ads/accounts/${accountId}/adsets`, {
      params: campaignId ? { campaignId } : {},
    })
    .then((r) => r.data);

export const setEntityBudget = (
  accountId: string,
  entityId: string,
  dailyBudget: number,
): Promise<unknown> =>
  marketingApi
    .post(`/ads/accounts/${accountId}/entities/${entityId}/budget`, { dailyBudget })
    .then((r) => r.data);

export const setEntityStatus = (
  accountId: string,
  entityId: string,
  status: AdEntityStatus,
): Promise<unknown> =>
  marketingApi
    .post(`/ads/accounts/${accountId}/entities/${entityId}/status`, { status })
    .then((r) => r.data);

export const duplicateCampaign = (accountId: string, campaignId: string): Promise<unknown> =>
  marketingApi
    .post(`/ads/accounts/${accountId}/campaigns/${campaignId}/duplicate`)
    .then((r) => r.data);

export const createCampaign = (
  accountId: string,
  payload: { name: string; objective: string },
): Promise<unknown> =>
  marketingApi.post(`/ads/accounts/${accountId}/campaigns`, payload).then((r) => r.data);

// ── Scaling rules ────────────────────────────────────────────────────────────

export type RuleMetric = 'SPEND' | 'CPL' | 'CTR' | 'LEADS' | 'CLICKS' | 'IMPRESSIONS';
export type RuleOperator = 'GT' | 'LT' | 'GTE' | 'LTE';
export type RuleAction = 'INCREASE_BUDGET' | 'DECREASE_BUDGET' | 'PAUSE' | 'RESUME';

export interface AdRule {
  id: string;
  adAccountId: string;
  name: string;
  enabled: boolean;
  metric: RuleMetric;
  operator: RuleOperator;
  threshold: number;
  windowDays: number;
  action: RuleAction;
  actionValue: number | null;
  maxBudget: number | null;
  minBudget: number | null;
  cooldownHours: number;
  lastRunAt: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
}

export interface AdRuleLog {
  id: string;
  entityId: string;
  entityName: string | null;
  action: string;
  detail: string | null;
  ok: boolean;
  createdAt: string;
}

export interface CreateRulePayload {
  adAccountId: string;
  name: string;
  metric: RuleMetric;
  operator: RuleOperator;
  threshold: number;
  action: RuleAction;
  windowDays?: number;
  actionValue?: number | null;
  maxBudget?: number | null;
  minBudget?: number | null;
  cooldownHours?: number;
  enabled?: boolean;
}

export type UpdateRulePayload = Partial<Omit<CreateRulePayload, 'adAccountId'>>;

export interface RuleRunResult {
  actions: Array<{ entityId: string; entityName: string | null; action: string; detail: string | null; ok: boolean }>;
}

export const listAdRules = (): Promise<AdRule[]> =>
  marketingApi.get('/ads/rules').then((r) => r.data);

export const getAdRuleLogs = (id: string): Promise<AdRuleLog[]> =>
  marketingApi.get(`/ads/rules/${id}/logs`).then((r) => r.data);

export const createAdRule = (payload: CreateRulePayload): Promise<AdRule> =>
  marketingApi.post('/ads/rules', payload).then((r) => r.data);

export const updateAdRule = (id: string, payload: UpdateRulePayload): Promise<AdRule> =>
  marketingApi.patch(`/ads/rules/${id}`, payload).then((r) => r.data);

export const deleteAdRule = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/ads/rules/${id}`).then((r) => r.data);

export const runAdRule = (id: string): Promise<RuleRunResult> =>
  marketingApi.post(`/ads/rules/${id}/run`).then((r) => r.data);
