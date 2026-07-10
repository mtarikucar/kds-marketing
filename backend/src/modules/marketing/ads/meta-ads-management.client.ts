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

export interface MetaAudienceUploadResult {
  ok: boolean;
  numReceived?: number;
  numInvalid?: number;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Create an ad set under a campaign. Budget is in the account currency's MINOR
 * units (cents). `targeting` (geo/age/genders/platforms) and `promotedObject`
 * (page_id for lead-gen, or pixel_id + custom_event_type for conversions) are
 * nested objects Meta requires as JSON-stringified strings under an
 * application/json body — the same convention as special_ad_categories /
 * lookalike_spec. Defaults to PAUSED so a create never starts spending.
 */
export async function createAdSet(
  token: string,
  externalAdId: string,
  input: {
    name: string;
    campaignId: string;
    optimizationGoal: string;
    billingEvent: string;
    dailyBudgetCents: number;
    targeting: Record<string, any>;
    promotedObject?: Record<string, any>;
    bidStrategy?: string;
    status?: string;
    startTime?: string;
    endTime?: string;
  },
): Promise<MetaWriteResult> {
  const body: Record<string, any> = {
    name: input.name,
    campaign_id: input.campaignId,
    optimization_goal: input.optimizationGoal,
    billing_event: input.billingEvent,
    bid_strategy: input.bidStrategy ?? 'LOWEST_COST_WITHOUT_CAP',
    daily_budget: input.dailyBudgetCents,
    targeting: JSON.stringify(input.targeting),
    status: input.status ?? 'PAUSED',
  };
  if (input.promotedObject) body.promoted_object = JSON.stringify(input.promotedObject);
  if (input.startTime) body.start_time = input.startTime;
  if (input.endTime) body.end_time = input.endTime;
  const r = await metaGraphFetch(`/${actOf(externalAdId)}/adsets`, {
    accessToken: token,
    method: 'POST',
    body,
    timeoutMs: 20_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta create adset') };
  const id = r.data?.id;
  return { ok: true, id: id ? String(id) : undefined };
}

/**
 * Upload an image to the ad account's image library and return its `hash` (used
 * as link_data.image_hash on the creative). metaGraphFetch is JSON-only, so the
 * image is sent base64-encoded under `bytes` rather than multipart. Meta COPIES
 * the bytes, so the source no longer has to stay reachable after this call.
 */
export async function uploadAdImage(
  token: string,
  externalAdId: string,
  bytesBase64: string,
): Promise<MetaWriteResult> {
  const r = await metaGraphFetch(`/${actOf(externalAdId)}/adimages`, {
    accessToken: token,
    method: 'POST',
    body: { bytes: bytesBase64 },
    timeoutMs: 30_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta upload image') };
  const images = r.data?.images ?? {};
  const firstKey = Object.keys(images)[0];
  const hash = firstKey ? images[firstKey]?.hash : undefined;
  return { ok: true, id: hash ? String(hash) : undefined };
}

/**
 * Register a video on the ad account by pull-from-URL (the same mechanism as the
 * social-planner FB video upload). Returns the async video id — processing is
 * NOT complete on return, so callers must waitVideoReady() before referencing it
 * from a creative.
 */
export async function uploadAdVideo(
  token: string,
  externalAdId: string,
  fileUrl: string,
  name: string,
): Promise<MetaWriteResult> {
  const r = await metaGraphFetch(`/${actOf(externalAdId)}/advideos`, {
    accessToken: token,
    method: 'POST',
    body: { file_url: fileUrl, name },
    timeoutMs: 60_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta upload video') };
  const id = r.data?.id;
  return { ok: true, id: id ? String(id) : undefined };
}

/**
 * Poll an uploaded ad video until Meta finishes processing it (video_status
 * flips to `ready`). A creative built against a still-processing video id fails,
 * so this is mandatory between uploadAdVideo and createAdCreative. Mirrors the
 * IG container-ready poll. Returns the videoId in `id` when ready.
 */
export async function waitVideoReady(
  token: string,
  videoId: string,
  opts: { intervalMs?: number; maxTries?: number } = {},
): Promise<MetaWriteResult> {
  const intervalMs = opts.intervalMs ?? 3000;
  const maxTries = opts.maxTries ?? 30;
  for (let i = 0; i < maxTries; i++) {
    const r = await metaGraphFetch(`/${videoId}`, {
      accessToken: token,
      query: { fields: 'status' },
      timeoutMs: 15_000,
    });
    if (!r.ok) return { ok: false, ...fail(r, 'Meta video status') };
    const status = r.data?.status?.video_status;
    if (status === 'ready') return { ok: true, id: videoId };
    if (status === 'error') {
      return { ok: false, error: `Meta video processing failed: ${videoId}` };
    }
    await sleep(intervalMs);
  }
  return { ok: false, error: `Meta video processing timed out: ${videoId}` };
}

/**
 * Create an ad creative from an object_story_spec. Supply `linkData` (single
 * image/link ad) OR `videoData` (video ad); `pageId` is the Facebook Page the ad
 * publishes as (and `instagramActorId` the optional IG actor). Meta requires the
 * whole object_story_spec as a JSON-stringified string under application/json.
 */
export async function createAdCreative(
  token: string,
  externalAdId: string,
  input: {
    name: string;
    pageId: string;
    instagramActorId?: string;
    linkData?: Record<string, any>;
    videoData?: Record<string, any>;
  },
): Promise<MetaWriteResult> {
  const objectStorySpec: Record<string, any> = { page_id: input.pageId };
  if (input.instagramActorId) objectStorySpec.instagram_actor_id = input.instagramActorId;
  if (input.linkData) objectStorySpec.link_data = input.linkData;
  if (input.videoData) objectStorySpec.video_data = input.videoData;
  const r = await metaGraphFetch(`/${actOf(externalAdId)}/adcreatives`, {
    accessToken: token,
    method: 'POST',
    body: {
      name: input.name,
      object_story_spec: JSON.stringify(objectStorySpec),
    },
    timeoutMs: 20_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta create creative') };
  const id = r.data?.id;
  return { ok: true, id: id ? String(id) : undefined };
}

/**
 * Create the ad node that ties an ad set to a creative. `creative` is passed as
 * a JSON-stringified {creative_id} per Meta's object-param convention. Defaults
 * to PAUSED so launching never immediately spends — going ACTIVE is a deliberate
 * follow-up via the existing status route.
 */
export async function createAd(
  token: string,
  externalAdId: string,
  input: { name: string; adsetId: string; creativeId: string; status?: string },
): Promise<MetaWriteResult> {
  const r = await metaGraphFetch(`/${actOf(externalAdId)}/ads`, {
    accessToken: token,
    method: 'POST',
    body: {
      name: input.name,
      adset_id: input.adsetId,
      creative: JSON.stringify({ creative_id: input.creativeId }),
      status: input.status ?? 'PAUSED',
    },
    timeoutMs: 20_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta create ad') };
  const id = r.data?.id;
  return { ok: true, id: id ? String(id) : undefined };
}

/**
 * Create a hashed-customer-list Custom Audience on the ad account. Population
 * happens via addAudienceUsers (a separate session upload) — this only creates
 * the empty container. Needs an ads_management token.
 */
export async function createCustomAudience(
  token: string,
  externalAdId: string,
  input: { name: string; description?: string },
): Promise<MetaWriteResult> {
  const r = await metaGraphFetch(`/${actOf(externalAdId)}/customaudiences`, {
    accessToken: token,
    method: 'POST',
    body: {
      name: input.name,
      description: input.description ?? 'Synced from Jeeta CRM segment',
      subtype: 'CUSTOM',
      customer_file_source: 'USER_PROVIDED_ONLY',
    },
    timeoutMs: 20_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta create audience') };
  const id = r.data?.id;
  return { ok: true, id: id ? String(id) : undefined };
}

/**
 * Upload one batch of hashed users to a Custom Audience. `schema` names the
 * hashed keys (e.g. ['EMAIL','PHONE']); `rows` is a parallel array of hashed
 * value tuples. `session` drives Meta's multi-batch protocol (constant
 * session_id, 1-based batch_seq, last_batch_flag on the final batch).
 */
export async function addAudienceUsers(
  token: string,
  audienceId: string,
  schema: string[],
  rows: string[][],
  session: { session_id: number; batch_seq: number; last_batch_flag: boolean; estimated_num_total: number },
): Promise<MetaAudienceUploadResult> {
  const r = await metaGraphFetch(`/${audienceId}/users`, {
    accessToken: token,
    method: 'POST',
    body: {
      payload: { schema, data: rows },
      session,
    },
    timeoutMs: 30_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta audience upload') };
  return {
    ok: true,
    numReceived: num(r.data?.num_received) ?? undefined,
    numInvalid: num(r.data?.num_invalid_entries) ?? undefined,
  };
}

/**
 * Seed a Lookalike Audience from an already-populated source Custom Audience.
 * The seed must have enough matched users (Meta min ~100) or this fails, so it
 * is sequenced AFTER a populate, never chained synchronously.
 */
export async function createLookalikeAudience(
  token: string,
  externalAdId: string,
  input: { name: string; seedAudienceId: string; country: string; ratio: number },
): Promise<MetaWriteResult> {
  const r = await metaGraphFetch(`/${actOf(externalAdId)}/customaudiences`, {
    accessToken: token,
    method: 'POST',
    body: {
      name: input.name,
      subtype: 'LOOKALIKE',
      origin_audience_id: input.seedAudienceId,
      lookalike_spec: JSON.stringify({
        type: 'similarity',
        country: input.country,
        ratio: input.ratio,
      }),
    },
    timeoutMs: 20_000,
  });
  if (!r.ok) return { ok: false, ...fail(r, 'Meta create lookalike') };
  const id = r.data?.id;
  return { ok: true, id: id ? String(id) : undefined };
}
