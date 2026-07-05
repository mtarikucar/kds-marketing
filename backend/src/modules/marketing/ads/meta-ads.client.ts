import { metaGraphFetch, metaGraphFollow, MetaGraphResult } from '../../../common/util/meta-graph.util';
import { AdMetricRow } from './ads.types';

/** Bound the pagination loop so a pathological provider response can't run forever. */
const MAX_PAGES = 50;

/**
 * Source-specific lead action types that do NOT overlap with each other:
 * on-Meta instant-form leads (deduplicated/grouped) and website-pixel "Lead"
 * events. Meta ALSO emits a generic `lead` aggregate that double-counts the
 * grouped/pixel values, so we never sum the generic together with these.
 */
const SPECIFIC_LEAD_TYPES = new Set([
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
]);

/**
 * Deduplicated lead count from the `actions` breakdown. Prefer the distinct,
 * non-overlapping source-specific types (instant-form + pixel); only when none
 * are present fall back to the generic `lead` total. The old behaviour summed
 * EVERY action type containing 'lead', double-counting instant-form leads
 * (reported as both `lead` and `onsite_conversion.lead_grouped`).
 */
function leadCount(actions: any[]): number {
  const sum = (pred: (t: string) => boolean) =>
    actions
      .filter((a) => pred(String(a?.action_type ?? '')))
      .reduce((s: number, a: any) => s + Number(a?.value || 0), 0);
  const specific = sum((t) => SPECIFIC_LEAD_TYPES.has(t));
  return specific > 0 ? specific : sum((t) => t === 'lead');
}

/**
 * Source-specific purchase action types that do NOT overlap with each other —
 * same dedup principle as SPECIFIC_LEAD_TYPES: Meta's `omni_purchase` already
 * aggregates (and deduplicates) the pixel + onsite values, so it is preferred;
 * only when it is absent do we sum the distinct specific types.
 */
const SPECIFIC_PURCHASE_TYPES = new Set([
  'offsite_conversion.fb_pixel_purchase',
  'onsite_conversion.purchase',
]);

/**
 * Provider-reported purchase value for a row (Growth Autopilot D10 cold-start
 * revenue). Order: deduplicated `omni_purchase` action value → sum of the
 * distinct specific purchase values → `purchase_roas` × spend → 0.
 */
function purchaseValue(d: any): number {
  const values: any[] = Array.isArray(d?.action_values) ? d.action_values : [];
  const omni = values.find((a) => String(a?.action_type ?? '') === 'omni_purchase');
  if (omni) return Number(omni?.value || 0);
  const specific = values
    .filter((a) => SPECIFIC_PURCHASE_TYPES.has(String(a?.action_type ?? '')))
    .reduce((s: number, a: any) => s + Number(a?.value || 0), 0);
  if (specific > 0) return specific;
  const roasArr: any[] = Array.isArray(d?.purchase_roas) ? d.purchase_roas : [];
  const roas = roasArr.find((r) => String(r?.action_type ?? '') === 'omni_purchase') ?? roasArr[0];
  if (roas) return Number(roas?.value || 0) * Number(d?.spend || 0);
  return 0;
}

function parseMetaRow(d: any, fallbackDate: string): AdMetricRow {
  const leads = leadCount(Array.isArray(d?.actions) ? d.actions : []);
  return {
    date: String(d?.date_start ?? fallbackDate).slice(0, 10),
    campaignId: String(d?.campaign_id ?? ''),
    spend: Number(d?.spend || 0),
    impressions: Number(d?.impressions || 0),
    clicks: Number(d?.clicks || 0),
    leads,
    conversionValue: purchaseValue(d),
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
      fields: 'spend,impressions,clicks,actions,action_values,purchase_roas,campaign_id,date_start',
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
