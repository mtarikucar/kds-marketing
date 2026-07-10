import { AdMetricRow } from './ads.types';
import {
  googleAdsFetch,
  refreshAccessToken,
  normalizeCustomerId,
  GoogleAdsResult,
  GoogleWriteResult,
} from './google-ads.util';

/**
 * Google Ads READ + WRITE client (googleads.googleapis.com). The sibling of
 * meta-ads.client + meta-ads-management.client, collapsed into one file because
 * Google reaches metrics (searchStream/GAQL) and mutations (campaignBudgets /
 * campaigns :mutate) through the same REST surface + auth.
 *
 * Every entrypoint takes the account's REFRESH token and mints a short-lived
 * access token itself (via google-ads.util.refreshAccessToken) so the calling
 * service seam stays identical to Meta/TikTok/LinkedIn — the service opens the
 * sealed secret and passes it straight through; only the CLIENT knows Google
 * needs the extra refresh step.
 *
 * Budgets are in MICROS (the account currency's millionths — Google's minor
 * unit, analogous to Meta cents); the service converts to/from major units.
 * Kept a plain module (like the Meta clients) so it mocks at the safeFetch seam.
 */

interface CustomerScope {
  /** The MCC the client cid is reached through. Defaults to the platform env. */
  loginCustomerId?: string | null;
}

function fail(r: GoogleAdsResult, prefix: string): { error: string; isAuthError: boolean } {
  return { error: `${prefix}: ${r.error.message}`.slice(0, 400), isAuthError: r.error.isAuthError };
}

/** A `:mutate` response is `{ results: [{ resourceName }] }`; pull the first. */
function firstMutateResourceName(data: any): string | undefined {
  const rn = Array.isArray(data?.results) ? data.results[0]?.resourceName : undefined;
  return typeof rn === 'string' ? rn : undefined;
}

/** Expand a bare id into a full resource name; pass a full resource name through. */
function resourceName(cid: string, collection: string, idOrName: string): string {
  return String(idOrName).includes('/')
    ? String(idOrName)
    : `customers/${cid}/${collection}/${idOrName}`;
}

function parseGoogleRow(result: any, fallbackDate: string): AdMetricRow {
  const m = result?.metrics ?? {};
  const seg = result?.segments ?? {};
  const camp = result?.campaign ?? {};
  return {
    date: String(seg?.date ?? fallbackDate).slice(0, 10),
    campaignId: String(camp?.id ?? ''),
    // cost_micros (int64, returned as a string) / 1e6 = spend in major units.
    spend: Number(m?.costMicros ?? m?.cost_micros ?? 0) / 1_000_000,
    impressions: Number(m?.impressions ?? 0),
    clicks: Number(m?.clicks ?? 0),
    leads: Number(m?.conversions ?? 0),
    conversionValue: Number(m?.conversionsValue ?? m?.conversions_value ?? 0),
    raw: result,
  };
}

/**
 * Google Ads insights via `googleAds:searchStream` (GAQL). Per-day, per-campaign
 * spend / impressions / clicks (+ conversions as leads, conversions_value as
 * conversionValue) over [since, until]. The streamed response is a JSON array of
 * `{ results: [...] }` batches — walked in full (no first-batch truncation).
 * Throws on a non-ok result so the caller records lastError; the thrown Error
 * carries `isAuthError` (401 / UNAUTHENTICATED → true) so the caller can flag the
 * account needs-reauth. Returns [] for an empty range.
 */
export async function pullGoogleInsights(
  refreshToken: string,
  customerId: string,
  since: string,
  until: string,
  scope: CustomerScope = {},
): Promise<AdMetricRow[]> {
  const accessToken = await refreshAccessToken(refreshToken);
  const cid = normalizeCustomerId(customerId);
  const query =
    'SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, ' +
    'metrics.clicks, metrics.conversions, metrics.conversions_value ' +
    `FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`;

  const r = await googleAdsFetch(`/customers/${cid}/googleAds:searchStream`, {
    accessToken,
    customerId: cid,
    loginCustomerId: scope.loginCustomerId,
    method: 'POST',
    body: { query },
    timeoutMs: 30_000,
  });
  if (!r.ok) {
    const err: any = new Error(`Google ads ${r.status}: ${String(r.error?.message ?? r.status).slice(0, 300)}`);
    err.isAuthError = r.error?.isAuthError ?? false;
    throw err;
  }

  const batches = Array.isArray(r.data) ? r.data : [r.data];
  const rows: AdMetricRow[] = [];
  for (const batch of batches) {
    for (const result of batch?.results ?? []) rows.push(parseGoogleRow(result, since));
  }
  return rows;
}

/**
 * Set a campaign-budget's daily amount via `campaignBudgets:mutate`. `amountMajor`
 * is in the account currency's MAJOR units → converted to micros (×1e6, int64 as
 * a string). `budget` is a campaignBudget id or a full resource name (the id
 * comes from a campaign.campaign_budget lookup, done by the service).
 */
export async function setCampaignBudget(
  refreshToken: string,
  customerId: string,
  budget: string,
  amountMajor: number,
  scope: CustomerScope = {},
): Promise<GoogleWriteResult> {
  const accessToken = await refreshAccessToken(refreshToken);
  const cid = normalizeCustomerId(customerId);
  const rn = resourceName(cid, 'campaignBudgets', budget);
  const r = await googleAdsFetch(`/customers/${cid}/campaignBudgets:mutate`, {
    accessToken,
    customerId: cid,
    loginCustomerId: scope.loginCustomerId,
    method: 'POST',
    body: {
      operations: [
        {
          update: { resourceName: rn, amountMicros: String(Math.round(amountMajor * 1_000_000)) },
          updateMask: 'amount_micros',
        },
      ],
    },
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Google set budget') };
  return { ok: true, id: firstMutateResourceName(r.data) ?? rn };
}

/** Pause / resume a campaign via `campaigns:mutate` (status ENABLED | PAUSED).
 *  `campaign` is a campaign id or a full resource name. */
export async function setCampaignStatus(
  refreshToken: string,
  customerId: string,
  campaign: string,
  status: 'ENABLED' | 'PAUSED',
  scope: CustomerScope = {},
): Promise<GoogleWriteResult> {
  const accessToken = await refreshAccessToken(refreshToken);
  const cid = normalizeCustomerId(customerId);
  const rn = resourceName(cid, 'campaigns', campaign);
  const r = await googleAdsFetch(`/customers/${cid}/campaigns:mutate`, {
    accessToken,
    customerId: cid,
    loginCustomerId: scope.loginCustomerId,
    method: 'POST',
    body: {
      operations: [{ update: { resourceName: rn, status }, updateMask: 'status' }],
    },
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Google set status') };
  return { ok: true, id: firstMutateResourceName(r.data) ?? rn };
}
