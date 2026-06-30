import {
  metaGraphFetch,
  metaGraphFollow,
  MetaGraphResult,
} from '../../../common/util/meta-graph.util';
import { withPermissionHint } from './meta-ads-error.util';

/**
 * Meta Marketing API WRITE client — campaign/adset listing + management
 * (budget, status, duplicate, create). Distinct from meta-ads.client.ts which is
 * read-only insights. Every call needs a token with `ads_management` (not just
 * `ads_read`). Budgets are in the account currency's MINOR units (cents) as Meta
 * requires; the service converts to/from major units.
 */

const MAX_PAGES = 20;

export interface MetaAdEntity {
  id: string;
  name: string;
  status: string;
  effectiveStatus?: string;
  objective?: string;
  campaignId?: string;
  /** Minor units (cents), as returned by Meta. null when not budget-bearing. */
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
}

export interface MetaListResult {
  ok: boolean;
  items: MetaAdEntity[];
  error?: string;
  isAuthError?: boolean;
}

export interface MetaWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  isAuthError?: boolean;
}

function actOf(externalAdId: string): string {
  return externalAdId.startsWith('act_') ? externalAdId : `act_${externalAdId}`;
}

function num(v: any): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fail(r: MetaGraphResult, prefix: string): { error: string; isAuthError: boolean } {
  // Append actionable guidance when Meta's opaque "missing permissions / does
  // not exist" surfaces on a write the token isn't scoped/roled for.
  return { error: withPermissionHint(`${prefix}: ${r.error.message}`.slice(0, 400)), isAuthError: r.error.isAuthError };
}

async function listEdge(
  token: string,
  path: string,
  fields: string,
  map: (d: any) => MetaAdEntity,
): Promise<MetaListResult> {
  const items: MetaAdEntity[] = [];
  let result = await metaGraphFetch(path, {
    accessToken: token,
    method: 'GET',
    query: { fields, limit: '200' },
    timeoutMs: 20_000,
  });
  for (let page = 0; page < MAX_PAGES; page++) {
    if (!result.ok) {
      const f = fail(result, 'Meta list');
      return { ok: false, items, error: f.error, isAuthError: f.isAuthError };
    }
    for (const d of result.data?.data ?? []) items.push(map(d));
    const next = typeof result.data?.paging?.next === 'string' ? result.data.paging.next : null;
    if (!next) break;
    result = await metaGraphFollow(next, token, 20_000);
  }
  return { ok: true, items };
}

export function listCampaigns(token: string, externalAdId: string): Promise<MetaListResult> {
  return listEdge(
    token,
    `/${actOf(externalAdId)}/campaigns`,
    'id,name,status,effective_status,objective,daily_budget,lifetime_budget',
    (d) => ({
      id: String(d.id),
      name: String(d.name ?? ''),
      status: String(d.status ?? ''),
      effectiveStatus: d.effective_status,
      objective: d.objective,
      dailyBudget: num(d.daily_budget),
      lifetimeBudget: num(d.lifetime_budget),
    }),
  );
}

export function listAdSets(
  token: string,
  externalAdId: string,
  campaignId?: string,
): Promise<MetaListResult> {
  const path = campaignId ? `/${campaignId}/adsets` : `/${actOf(externalAdId)}/adsets`;
  return listEdge(
    token,
    path,
    'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget',
    (d) => ({
      id: String(d.id),
      name: String(d.name ?? ''),
      status: String(d.status ?? ''),
      effectiveStatus: d.effective_status,
      campaignId: d.campaign_id ? String(d.campaign_id) : undefined,
      dailyBudget: num(d.daily_budget),
      lifetimeBudget: num(d.lifetime_budget),
    }),
  );
}

/** Generic node update (campaign/adset/ad all accept POST /{id} with fields). */
export async function updateEntity(
  token: string,
  entityId: string,
  fields: Record<string, string | number>,
): Promise<MetaWriteResult> {
  const r = await metaGraphFetch(`/${entityId}`, {
    accessToken: token,
    method: 'POST',
    body: fields,
    timeoutMs: 20_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta update') };
  return { ok: true, id: entityId };
}

/** Deep-copy a campaign (adsets + ads), leaving the copy PAUSED. */
export async function duplicateCampaign(token: string, campaignId: string): Promise<MetaWriteResult> {
  const r = await metaGraphFetch(`/${campaignId}/copies`, {
    accessToken: token,
    method: 'POST',
    body: { deep_copy: true, status_option: 'PAUSED' },
    timeoutMs: 30_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta duplicate') };
  const id = r.data?.copied_campaign_id ?? r.data?.id;
  return { ok: true, id: id ? String(id) : undefined };
}

/** Create a campaign shell (PAUSED). Adsets/ads/creative are a follow-up. */
export async function createCampaign(
  token: string,
  externalAdId: string,
  input: { name: string; objective: string; status?: string },
): Promise<MetaWriteResult> {
  const r = await metaGraphFetch(`/${actOf(externalAdId)}/campaigns`, {
    accessToken: token,
    method: 'POST',
    body: {
      name: input.name,
      objective: input.objective,
      status: input.status ?? 'PAUSED',
      special_ad_categories: JSON.stringify([]),
    },
    timeoutMs: 20_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta create campaign') };
  const id = r.data?.id;
  return { ok: true, id: id ? String(id) : undefined };
}
