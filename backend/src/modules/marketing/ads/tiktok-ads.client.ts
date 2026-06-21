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
      throw new Error(`TikTok ads: ${String(json?.message ?? res.status).slice(0, 300)}`);
    }
    for (const item of json?.data?.list ?? []) rows.push(parseTiktokRow(item, since));
    // page_info.total_page tells us how many pages exist; clamp to MAX_PAGES.
    const reported = Number(json?.data?.page_info?.total_page);
    totalPages = Number.isFinite(reported) && reported > 0 ? Math.min(reported, MAX_PAGES) : page;
    page++;
  } while (page <= totalPages);
  return rows;
}
