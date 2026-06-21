import { safeFetch } from '../../../common/util/safe-fetch';
import { AdMetricRow } from './ads.types';

/** Bound the pagination loop so a pathological provider response can't run forever. */
const MAX_PAGES = 50;

function parseMetaRow(d: any, fallbackDate: string): AdMetricRow {
  const leads = (d?.actions ?? [])
    .filter((a: any) => String(a?.action_type ?? '').includes('lead'))
    .reduce((s: number, a: any) => s + Number(a?.value || 0), 0);
  return {
    date: String(d?.date_start ?? fallbackDate).slice(0, 10),
    campaignId: String(d?.campaign_id ?? ''),
    spend: Number(d?.spend || 0),
    impressions: Number(d?.impressions || 0),
    clicks: Number(d?.clicks || 0),
    leads,
    raw: d,
  };
}

/**
 * Meta Ads insights via the Marketing API (Graph v19.0). Per-day, per-campaign
 * spend/impressions/clicks + lead conversions (from the `actions` breakdown).
 * Follows `paging.next` until exhausted (bounded by MAX_PAGES) so large accounts
 * are not silently truncated to the first page. Throws on a provider error so
 * the caller records lastError; returns [] for an empty range. SSRF-safe +
 * bounded via safeFetch on EVERY page (the `next` URL is provider-issued).
 */
export async function pullMetaInsights(
  token: string,
  externalAdId: string,
  since: string,
  until: string,
): Promise<AdMetricRow[]> {
  const actId = externalAdId.startsWith('act_') ? externalAdId : `act_${externalAdId}`;
  const qs = new URLSearchParams({
    fields: 'spend,impressions,clicks,actions,campaign_id,date_start',
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    limit: '500',
    access_token: token,
  });

  const rows: AdMetricRow[] = [];
  let url: string | null = `https://graph.facebook.com/v19.0/${actId}/insights?${qs}`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await safeFetch(url, { method: 'GET', timeoutMs: 20_000 });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Meta ads ${res.status}: ${String(json?.error?.message ?? '').slice(0, 300)}`);
    }
    for (const d of json?.data ?? []) rows.push(parseMetaRow(d, since));
    // `paging.next` is an absolute, provider-issued URL that already carries the
    // access_token and the `after` cursor; absent once the last page is reached.
    url = typeof json?.paging?.next === 'string' ? json.paging.next : null;
  }
  return rows;
}
