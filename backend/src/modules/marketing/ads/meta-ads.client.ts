import { metaGraphFetch, metaGraphFollow, MetaGraphResult } from '../../../common/util/meta-graph.util';
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
 * Meta Ads insights via the Marketing API. Per-day, per-campaign
 * spend/impressions/clicks + lead conversions (from the `actions` breakdown).
 * Follows `paging.next` until exhausted (bounded by MAX_PAGES) so large accounts
 * are not silently truncated to the first page. Throws on a provider error so
 * the caller records lastError; the thrown error carries `isAuthError` so the
 * caller can mark the account needs-reauth. Returns [] for an empty range.
 * Every page goes through the shared meta-graph helper (SSRF-safe via safeFetch,
 * appsecret_proof appended, version from GRAPH_API_VERSION).
 */
export async function pullMetaInsights(
  token: string,
  externalAdId: string,
  since: string,
  until: string,
): Promise<AdMetricRow[]> {
  const actId = externalAdId.startsWith('act_') ? externalAdId : `act_${externalAdId}`;
  const rows: AdMetricRow[] = [];
  let result: MetaGraphResult = await metaGraphFetch(`/${actId}/insights`, {
    accessToken: token,
    method: 'GET',
    query: {
      fields: 'spend,impressions,clicks,actions,campaign_id,date_start',
      level: 'campaign',
      time_increment: '1',
      time_range: JSON.stringify({ since, until }),
      limit: '500',
    },
    timeoutMs: 20_000,
  });

  for (let page = 0; page < MAX_PAGES; page++) {
    if (!result.ok) {
      const e: any = new Error(`Meta ads ${result.status}: ${result.error.message.slice(0, 300)}`);
      e.isAuthError = result.error.isAuthError;
      throw e;
    }
    const json: any = result.data;
    for (const d of json?.data ?? []) rows.push(parseMetaRow(d, since));
    // `paging.next` is an absolute, provider-issued URL that already carries the
    // access_token and the `after` cursor; absent once the last page is reached.
    const next = typeof json?.paging?.next === 'string' ? json.paging.next : null;
    if (!next) break;
    result = await metaGraphFollow(next, token, 20_000);
  }
  return rows;
}
