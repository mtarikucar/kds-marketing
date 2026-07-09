import { metaGraphFetch, metaGraphFollow, MetaGraphResult } from '../../../common/util/meta-graph.util';
import { AdMetricRow } from './ads.types';

/** Bound the pagination loop so a pathological provider response can't run forever. */
const MAX_PAGES = 50;

/**
 * A granular, additive ad-metric row: the same shape as a canonical AdMetricRow
 * plus the breakdown discriminators (level/ad/adset ids, placement, demographic
 * type+value) and the per-attribution-window counters. These rows are ADDITIVE —
 * they live alongside the canonical `level:'campaign'` rows and must never be
 * summed together with them (see AdMetric double-count guard in the integrator).
 */
export interface AdBreakdownRow extends AdMetricRow {
  /** Always 'ad' — these rows are pulled at level=ad. */
  level: 'ad';
  adId: string;
  adName?: string;
  adSetId: string;
  adSetName?: string;
  /** `${publisher_platform}:${platform_position}` (e.g. `facebook:feed`); '' on demographic rows. */
  placement: string;
  /** '' on placement rows; 'age' | 'gender' | 'region' | 'country' on demographic rows. */
  breakdownType: string;
  /** The bucket value for `breakdownType` (e.g. `25-34`, `female`); '' on placement rows. */
  breakdownValue: string;
  /** `conversionValue` (inherited) is the account-default window; these are the ALTERNATE views. */
  leads1dClick: number;
  leads7dClick: number;
  leads1dView: number;
  convValue1dClick: number;
  convValue7dClick: number;
  convValue1dView: number;
}

/**
 * The attribution-window sub-key carried on each `actions[]` / `action_values[]`
 * entry when `action_attribution_windows=1d_click,7d_click,1d_view` is requested.
 * `value` is the account default (7d_click + 1d_view) and stays in the canonical
 * `leads` / `conversionValue` fields for backward compat.
 */
type WindowKey = 'value' | '1d_click' | '7d_click' | '1d_view';

/**
 * Source-specific lead action types that do NOT overlap with each other:
 * on-Meta instant-form leads (deduplicated/grouped) and website-pixel "Lead"
 * events. Meta ALSO emits a generic `lead` aggregate that double-counts the
 * grouped/pixel values, so we never sum the generic together with these.
 * (Mirrors meta-ads.client.ts — kept local so per-window parsing can reuse it.)
 */
const SPECIFIC_LEAD_TYPES = new Set([
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
]);

/**
 * Source-specific purchase action types that do NOT overlap with each other —
 * same dedup principle as SPECIFIC_LEAD_TYPES: Meta's `omni_purchase` already
 * aggregates (and deduplicates) the pixel + onsite values, so it is preferred.
 */
const SPECIFIC_PURCHASE_TYPES = new Set([
  'offsite_conversion.fb_pixel_purchase',
  'onsite_conversion.purchase',
]);

/**
 * Deduplicated lead count from the `actions` breakdown for a single attribution
 * window (`win`). Prefer the distinct, non-overlapping source-specific types
 * (instant-form + pixel); only when none are present fall back to the generic
 * `lead` total — never sum both, or instant-form leads double-count. Reads the
 * per-window sub-key (`a[win]`) instead of only `a.value`.
 */
function leadCount(actions: any[], win: WindowKey): number {
  const sum = (pred: (t: string) => boolean) =>
    actions
      .filter((a) => pred(String(a?.action_type ?? '')))
      .reduce((s: number, a: any) => s + Number(a?.[win] || 0), 0);
  const specific = sum((t) => SPECIFIC_LEAD_TYPES.has(t));
  return specific > 0 ? specific : sum((t) => t === 'lead');
}

/**
 * Provider-reported purchase value for a row and a single attribution window.
 * Order: deduplicated `omni_purchase` → sum of the distinct specific purchase
 * values → (default window only) `purchase_roas` × spend → 0. `purchase_roas`
 * is not reported per-window, so the ROAS fallback applies only to `value`.
 */
function purchaseValue(d: any, win: WindowKey): number {
  const values: any[] = Array.isArray(d?.action_values) ? d.action_values : [];
  const omni = values.find((a) => String(a?.action_type ?? '') === 'omni_purchase');
  if (omni) return Number(omni?.[win] || 0);
  const specific = values
    .filter((a) => SPECIFIC_PURCHASE_TYPES.has(String(a?.action_type ?? '')))
    .reduce((s: number, a: any) => s + Number(a?.[win] || 0), 0);
  if (specific > 0) return specific;
  if (win === 'value') {
    const roasArr: any[] = Array.isArray(d?.purchase_roas) ? d.purchase_roas : [];
    const roas = roasArr.find((r) => String(r?.action_type ?? '') === 'omni_purchase') ?? roasArr[0];
    if (roas) return Number(roas?.value || 0) * Number(d?.spend || 0);
  }
  return 0;
}

/** The identity + numeric fields shared by every breakdown row, parsed once per insights cell. */
type CellBase = {
  date: string;
  campaignId: string;
  adId: string;
  adName?: string;
  adSetId: string;
  adSetName?: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  conversionValue: number;
  leads1dClick: number;
  leads7dClick: number;
  leads1dView: number;
  convValue1dClick: number;
  convValue7dClick: number;
  convValue1dView: number;
};

/** Parse a single level=ad insights cell into the identity + per-window numeric fields. */
function parseCell(d: any, fallbackDate: string): CellBase {
  const actions = Array.isArray(d?.actions) ? d.actions : [];
  return {
    date: String(d?.date_start ?? fallbackDate).slice(0, 10),
    campaignId: String(d?.campaign_id ?? ''),
    adId: String(d?.ad_id ?? ''),
    adName: d?.ad_name != null ? String(d.ad_name) : undefined,
    adSetId: String(d?.adset_id ?? ''),
    adSetName: d?.adset_name != null ? String(d.adset_name) : undefined,
    spend: Number(d?.spend || 0),
    impressions: Number(d?.impressions || 0),
    clicks: Number(d?.clicks || 0),
    leads: leadCount(actions, 'value'),
    conversionValue: purchaseValue(d, 'value'),
    leads1dClick: leadCount(actions, '1d_click'),
    leads7dClick: leadCount(actions, '7d_click'),
    leads1dView: leadCount(actions, '1d_view'),
    convValue1dClick: purchaseValue(d, '1d_click'),
    convValue7dClick: purchaseValue(d, '7d_click'),
    convValue1dView: purchaseValue(d, '1d_view'),
  };
}

const INSIGHTS_FIELDS =
  'spend,impressions,clicks,actions,action_values,purchase_roas,campaign_id,adset_id,ad_id,ad_name,adset_name,date_start';

/**
 * Fire one level=ad insights request for a single `breakdowns` family and follow
 * `paging.next` until exhausted (bounded by MAX_PAGES), returning the raw cells.
 * Mirrors pullMetaInsights' transport exactly: shared meta-graph helper (SSRF-safe
 * via safeFetch, appsecret_proof appended, version from GRAPH_API_VERSION); throws
 * on a provider error with `isAuthError` propagated so the caller's reauth path fires.
 */
async function fetchBreakdownCells(
  token: string,
  actId: string,
  since: string,
  until: string,
  breakdowns: string,
): Promise<any[]> {
  const cells: any[] = [];
  let result: MetaGraphResult = await metaGraphFetch(`/${actId}/insights`, {
    accessToken: token,
    method: 'GET',
    query: {
      fields: INSIGHTS_FIELDS,
      level: 'ad',
      time_increment: '1',
      breakdowns,
      action_attribution_windows: '1d_click,7d_click,1d_view',
      time_range: JSON.stringify({ since, until }),
      limit: '500',
    },
    timeoutMs: 20_000,
  });

  for (let page = 0; page < MAX_PAGES; page++) {
    if (!result.ok) {
      const e: any = new Error(
        `Meta ads breakdown ${result.status}: ${result.error.message.slice(0, 300)}`,
      );
      e.isAuthError = result.error.isAuthError;
      throw e;
    }
    const json: any = result.data;
    for (const d of json?.data ?? []) cells.push(d);
    // `paging.next` is an absolute, provider-issued URL that already carries the
    // access_token and the `after` cursor; absent once the last page is reached.
    const next = typeof json?.paging?.next === 'string' ? json.paging.next : null;
    if (!next) break;
    result = await metaGraphFollow(next, token, 20_000);
  }
  return cells;
}

/**
 * Collapse the combined `breakdowns=age,gender` cells into 1:1 rows per single
 * demographic dimension. Meta returns one cell per (age × gender) pair; emitting
 * one row per pair per dimension would collide on the breakdown unique key
 * (breakdownType='age',breakdownValue='25-34' recurs across every gender), so we
 * sum each cell into BOTH its age bucket and its gender bucket. Result: the age
 * marginal and the gender marginal, each collision-free and additive-safe.
 */
function foldDemographic(cells: any[], fallbackDate: string): AdBreakdownRow[] {
  const acc = new Map<string, AdBreakdownRow>();
  for (const d of cells) {
    const base = parseCell(d, fallbackDate);
    const dims: Array<[string, string]> = [
      ['age', String(d?.age ?? '')],
      ['gender', String(d?.gender ?? '')],
    ];
    for (const [breakdownType, breakdownValue] of dims) {
      const key = `${base.date}|${base.adId}|${breakdownType}|${breakdownValue}`;
      let row = acc.get(key);
      if (!row) {
        row = {
          level: 'ad',
          date: base.date,
          campaignId: base.campaignId,
          adId: base.adId,
          adName: base.adName,
          adSetId: base.adSetId,
          adSetName: base.adSetName,
          placement: '',
          breakdownType,
          breakdownValue,
          spend: 0,
          impressions: 0,
          clicks: 0,
          leads: 0,
          conversionValue: 0,
          leads1dClick: 0,
          leads7dClick: 0,
          leads1dView: 0,
          convValue1dClick: 0,
          convValue7dClick: 0,
          convValue1dView: 0,
          raw: d,
        };
        acc.set(key, row);
      }
      row.spend += base.spend;
      row.impressions += base.impressions;
      row.clicks += base.clicks;
      row.leads += base.leads;
      row.conversionValue += base.conversionValue;
      row.leads1dClick += base.leads1dClick;
      row.leads7dClick += base.leads7dClick;
      row.leads1dView += base.leads1dView;
      row.convValue1dClick += base.convValue1dClick;
      row.convValue7dClick += base.convValue7dClick;
      row.convValue1dView += base.convValue1dView;
    }
  }
  return [...acc.values()];
}

/**
 * Meta Ads GRANULAR insights via the Marketing API — the additive companion to
 * pullMetaInsights (which stays level=campaign and untouched). Fires TWO level=ad
 * insights families, each with action_attribution_windows=1d_click,7d_click,1d_view:
 *
 *  1. `breakdowns=publisher_platform,platform_position` → one row per ad×placement×day,
 *     tagged placement=`${publisher_platform}:${platform_position}`.
 *  2. `breakdowns=age,gender` → folded into 1:1 age and gender marginal rows
 *     (Meta rejects publisher_platform/platform_position combined with age/gender,
 *     so this is a SEPARATE call).
 *
 * Returns AdBreakdownRow[] tagged with level='ad', ad/adset ids + names, the
 * placement or breakdownType/breakdownValue discriminators, the canonical
 * account-default `leads`/`conversionValue`, and the per-window counters. Each page
 * goes through the shared meta-graph helper (SSRF-safe, appsecret_proof, versioned);
 * a provider error throws with `isAuthError` so the caller's markReauth path applies.
 * Returns [] for an empty range. META-only — gate the call behind isMetaAdsConfigured.
 */
export async function pullMetaBreakdowns(
  token: string,
  externalAdId: string,
  since: string,
  until: string,
): Promise<AdBreakdownRow[]> {
  const actId = externalAdId.startsWith('act_') ? externalAdId : `act_${externalAdId}`;
  const rows: AdBreakdownRow[] = [];

  // ── Placement family (publisher_platform × platform_position) — already 1:1 per cell ──
  const placementCells = await fetchBreakdownCells(
    token,
    actId,
    since,
    until,
    'publisher_platform,platform_position',
  );
  for (const d of placementCells) {
    const base = parseCell(d, since);
    const platform = String(d?.publisher_platform ?? '');
    const position = String(d?.platform_position ?? '');
    const placement = platform || position ? `${platform}:${position}` : '';
    rows.push({
      level: 'ad',
      ...base,
      placement,
      breakdownType: '',
      breakdownValue: '',
      raw: d,
    });
  }

  // ── Demographic family (age × gender) — folded into 1:1 marginal rows ──
  const demoCells = await fetchBreakdownCells(token, actId, since, until, 'age,gender');
  rows.push(...foldDemographic(demoCells, since));

  return rows;
}
