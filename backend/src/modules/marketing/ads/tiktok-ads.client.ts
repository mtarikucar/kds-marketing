import { safeFetch } from '../../../common/util/safe-fetch';
import { AdMetricRow } from './ads.types';

/** Bound the pagination loop so a pathological provider response can't run forever. */
const MAX_PAGES = 50;
const PAGE_SIZE = 1000;

function parseTiktokRow(item: any, fallbackDate: string): AdMetricRow {
  const dims = item?.dimensions ?? {};
  const m = item?.metrics ?? {};
  return {
    date: String(dims?.stat_time_day ?? fallbackDate).slice(0, 10),
    campaignId: String(dims?.campaign_id ?? ''),
    spend: Number(m?.spend || 0),
    impressions: Number(m?.impressions || 0),
    clicks: Number(m?.clicks || 0),
    leads: Number(m?.conversion || 0),
    raw: item,
  };
}

/**
 * TikTok Ads insights via the Marketing API (Business API v1.3, integrated
 * report). Per-day, per-campaign spend/impressions/clicks (+ conversions as
 * leads). Walks `data.page_info.total_page` (bounded by MAX_PAGES) so large
 * accounts are not silently truncated to the first page. Throws on a non-zero
 * TikTok response code. SSRF-safe + bounded via safeFetch on every page.
 */
export async function pullTiktokInsights(
  token: string,
  advertiserId: string,
  since: string,
  until: string,
): Promise<AdMetricRow[]> {
  const rows: AdMetricRow[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const qs = new URLSearchParams({
      advertiser_id: advertiserId,
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: JSON.stringify(['campaign_id', 'stat_time_day']),
      metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'conversion']),
      start_date: since,
      end_date: until,
      page: String(page),
      page_size: String(PAGE_SIZE),
    });
    const res = await safeFetch(
      `https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?${qs}`,
      { method: 'GET', headers: { 'Access-Token': token }, timeoutMs: 20_000 },
    );
    const json: any = await res.json().catch(() => ({}));
    if (json?.code !== 0) {
      // Include the numeric code so the caller can classify auth failures
      // (reauth_required) reliably, not just by parsing the English message.
      throw new Error(`TikTok ads [${json?.code}]: ${String(json?.message ?? res.status).slice(0, 300)}`);
    }
    for (const item of json?.data?.list ?? []) rows.push(parseTiktokRow(item, since));
    // page_info.total_page tells us how many pages exist; clamp to MAX_PAGES.
    const reported = Number(json?.data?.page_info?.total_page);
    totalPages = Number.isFinite(reported) && reported > 0 ? Math.min(reported, MAX_PAGES) : page;
    page++;
  } while (page <= totalPages);
  return rows;
}

// ── WRITE (campaign management) ──────────────────────────────────────────────
//
// TikTok Business Ads Management writes, mirroring the read transport above
// (safeFetch → business-api.tiktok.com/open_api/v1.3, 'Access-Token' header,
// {code,message,data} envelope where code===0 is success). Unlike the read
// pulls these NEVER throw — they return a TiktokWriteResult (same shape as
// MetaWriteResult) so the service can flip the account to needs-reauth on an
// auth failure and surface a plain error otherwise.

const TIKTOK_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

/** WRITE result, mirroring MetaWriteResult { ok, id?, error?, isAuthError? }. */
export interface TiktokWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  isAuthError?: boolean;
}

/**
 * True when a TikTok response code/message signals a token/permission failure
 * that needs a reconnect. Same set matched on the read path
 * (ad-account.service.ts): 40001/40002 (param/permission), 40100–40110
 * (token/session). A non-auth code (e.g. 50000 server) stays retry-friendly.
 */
function isTiktokAuthFailure(code: any, message: any): boolean {
  return /access[_ ]?token|auth|not authorized|invalid token|\b(4000[12]|4010\d|40110)\b/i.test(
    `${code} ${message}`,
  );
}

/** Generic POST helper for the v1.3 write endpoints. Never throws. */
async function tiktokWrite(
  token: string,
  path: string,
  body: Record<string, unknown>,
): Promise<TiktokWriteResult> {
  let res: Response;
  try {
    res = await safeFetch(`${TIKTOK_API_BASE}/${path}`, {
      method: 'POST',
      headers: { 'Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 20_000,
    });
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? 'network error').slice(0, 400), isAuthError: false };
  }
  const json: any = await res.json().catch(() => ({}));
  if (json?.code !== 0) {
    // Carry the numeric code so the caller can classify auth failures reliably.
    return {
      ok: false,
      error: `TikTok write [${json?.code}]: ${String(json?.message ?? res.status).slice(0, 300)}`,
      isAuthError: isTiktokAuthFailure(json?.code, json?.message),
    };
  }
  return { ok: true, id: undefined };
}

/**
 * Set a TikTok campaign's daily budget. `dailyBudgetMajor` is in the
 * advertiser's ACCOUNT-CURRENCY MAJOR units (e.g. 50.00) — NOT Meta-style minor
 * units, so the caller must NOT ×100. `budget_mode: 'BUDGET_MODE_DAY'` is
 * mandatory or TikTok rejects the update. POSTs /campaign/update/.
 */
export function setTiktokCampaignBudget(
  token: string,
  advertiserId: string,
  campaignId: string,
  dailyBudgetMajor: number,
): Promise<TiktokWriteResult> {
  return tiktokWrite(token, 'campaign/update/', {
    advertiser_id: advertiserId,
    campaign_id: campaignId,
    budget: dailyBudgetMajor,
    budget_mode: 'BUDGET_MODE_DAY',
  });
}

/**
 * Pause/resume a TikTok campaign. Status lives on its OWN endpoint
 * (/campaign/status/update/) — NOT /campaign/update/ — and is set via
 * `operation_status` over a `campaign_ids` array: ACTIVE→ENABLE, PAUSED→DISABLE.
 */
export function setTiktokCampaignStatus(
  token: string,
  advertiserId: string,
  campaignId: string,
  status: 'ACTIVE' | 'PAUSED',
): Promise<TiktokWriteResult> {
  return tiktokWrite(token, 'campaign/status/update/', {
    advertiser_id: advertiserId,
    campaign_ids: [campaignId],
    operation_status: status === 'ACTIVE' ? 'ENABLE' : 'DISABLE',
  });
}
