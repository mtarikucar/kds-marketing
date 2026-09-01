import { Logger } from '@nestjs/common';
import { safeFetch } from '../../../common/util/safe-fetch';
import { classifyMetaError, metaGraphFetch } from '../../../common/util/meta-graph.util';
import { linkedinRest } from '../../../common/util/linkedin-api.util';
import { AccountRow, revealToken, isNetworkConfigured, IG_DIRECT_GRAPH } from './network-adapters';
import { OrganicInsights } from './social-post-metric.service';

/**
 * The READ half of the social integration — the sibling of network-adapters.ts.
 *
 * network-adapters.ts can push content to eight networks and has never once
 * been able to ask what happened to it. A workspace could publish forty posts a
 * month and the product had no answer to "did anyone see them", which is the
 * only question the customer actually cares about. This module is the missing
 * direction: given the same AccountRow the publisher uses, and the
 * externalPostId the publisher stored, fetch back what the provider is willing
 * to tell us about that post and about the account itself.
 *
 * It deliberately mirrors network-adapters.ts rather than inventing a second
 * house style: same AccountRow, the same `revealToken` (so a sealed token is
 * opened in exactly one place), the same `isNetworkConfigured` env gate, the
 * same shared transports (metaGraphFetch carries the ONE Graph version constant
 * and the appsecret_proof; linkedinRest carries the versioned REST headers;
 * safeFetch carries the SSRF guard), and the same "never throw, return a flat
 * result" contract. A flat result rather than a discriminated union because
 * this project sets strictNullChecks:false, under which TS does not narrow
 * `{ok:true}|{ok:false}` — see the same note on MetaGraphResult.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE OUTCOMES, AND WHY THEY ARE THREE AND NOT TWO
 *
 * A sweep over every connected account has to distinguish three things that all
 * look like "no numbers" from the outside, and conflating them produces a
 * dashboard that lies:
 *
 *   ok:true + data          — the provider answered. Store it.
 *   ok:true + unsupported   — this network has no insights API we can call at
 *                             all (Pinterest/GMB today, and LinkedIn personal
 *                             profiles always). There is nothing to retry and
 *                             nothing to fix; the UI must say "we cannot read
 *                             this network" instead of drawing a zero line,
 *                             because a zero line is a claim that nobody saw
 *                             the post and that claim would be false.
 *   ok:false + error        — we could have read it and did not: a missing
 *                             OAuth scope, a rate limit, a transport failure, a
 *                             dead token. Record it, count it, retry next tick.
 *
 * `isAuthError` narrows the third case to the one an operator can act on: the
 * token is dead and only a reconnect fixes it. The caller stamps
 * SocialAccount.lastError = 'reauth_required' for exactly that case and for no
 * other — see the long note in social-insights.service.ts about why a non-auth
 * insights failure must never be written to that column. Each network decides
 * that question with its own predicate, and for Meta the READ path uses
 * isMetaReauthError below rather than the shared classifier's isAuthError: a
 * permission or throttle error arrives stamped OAuthException too, and on this
 * side of the integration that must not read as "reconnect".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OAUTH SCOPES — READ THIS BEFORE FILING AN APP REVIEW
 *
 * Publishing and reading are granted separately by every one of these
 * providers, and today's connect flows ask only for the publish half. So a
 * perfectly healthy, actively-publishing account can return a permission error
 * from every call in this file, forever, and that is NOT a bug in the code —
 * it is a grant that was never requested. Each arm below names the scope it
 * needs in its own comment; the summary is:
 *
 *   FACEBOOK         read_insights + pages_read_engagement (page token)
 *   INSTAGRAM        instagram_manage_insights (+ the existing instagram_basic)
 *   INSTAGRAM_LOGIN  instagram_business_manage_insights
 *   LINKEDIN         r_organization_social (org only; personal has no API)
 *   TIKTOK           video.list (post metrics) + user.info.stats (followers)
 *   TWITTER/X        tweet.read + users.read (already requested)
 *
 * Of those, only X currently asks for what it needs. Everything else must be
 * added to social-oauth.config.ts AND approved by the provider's app review
 * before these calls stop returning permission errors. A missing scope
 * therefore degrades to `ok:false` with the provider's own message preserved —
 * never a throw, never a silent zero — so the coverage report can tell the
 * owner the truth about which networks are actually readable.
 */

const logger = new Logger('NetworkInsights');

/**
 * Per-post organic counts. This is OrganicInsights — the shape
 * SocialPostMetricService.upsert already accepts — reused deliberately rather
 * than redeclared, so a field added to the metric table flows through one type.
 *
 * Note that OrganicInsights carries `leads`, which nothing in this file ever
 * sets: leads are first-party (attributed Jeeta-side via LeadAttribution), not
 * something a social network reports. It stays part of the shared type because
 * it is part of the ROW; the provider read simply leaves it undefined, and
 * upsert()'s defaulting turns undefined into 0 without clobbering anything.
 */
export type PostInsights = OrganicInsights;

/**
 * Account-level counts for one day — the half SocialPostMetric structurally
 * cannot express, because a follower count belongs to the profile and not to
 * any one post. `followers` is a STOCK (a level at a point in time, never
 * summed across days); the other three are FLOWS the provider reports per day.
 */
export interface AccountInsights {
  followers?: number;
  profileViews?: number;
  reach?: number;
  impressions?: number;
  raw?: unknown;
}

export interface InsightsResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** True when the failure is a token problem needing reconnect (not a scope gap). */
  isAuthError?: boolean;
  /** True when this network/account has no insights API to call at all. */
  unsupported?: boolean;
}

// ──────────────────────────────────────────────────────────── small helpers

const okResult = <T>(data: T): InsightsResult<T> => ({ ok: true, data });
/** Nothing to call and nothing to fix — see "THE THREE OUTCOMES" above. */
const unsupportedResult = <T>(): InsightsResult<T> => ({ ok: true, unsupported: true });
const failResult = <T>(error: string, isAuthError = false): InsightsResult<T> => ({
  ok: false,
  error: String(error).slice(0, 500),
  isAuthError,
  unsupported: false,
});

/** Coerce an untrusted provider value to a non-negative integer. */
function num(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** Sum the values of a `{like: 3, love: 1, ...}` breakdown object. */
function sumBreakdown(v: unknown): number {
  if (!v || typeof v !== 'object') return 0;
  let total = 0;
  for (const n of Object.values(v as Record<string, unknown>)) total += num(n);
  return total;
}

/**
 * Pull one metric out of a Graph insights payload. Both Meta insights edges
 * answer with `{ data: [ { name, period, values: [ { value } ] } ] }`, and the
 * `value` is either a number (most metrics) or a breakdown object
 * (post_reactions_by_type_total). The LAST element of `values` is the most
 * recent bucket for period=day series, which is what a daily snapshot wants.
 */
function metaMetric(rows: unknown, name: string): unknown {
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find((r: any) => r?.name === name);
  const values = row?.values;
  if (!Array.isArray(values) || values.length === 0) return undefined;
  return values[values.length - 1]?.value;
}

// ──────────────────────────────── is a Meta READ failure actually a dead token?

/**
 * Graph error codes that mean "your app was never granted that permission":
 * #200 and #10 are the two the "Requires <scope> permission" message arrives
 * under, #3 is "this method is not available to your app", and #803 is the
 * object-not-addressable-by-this-token variant the Page edges return. Every one
 * of them is fixed by an app review or by a WIDER scope set at connect time —
 * never by the owner reconnecting the account they already have.
 */
const META_PERMISSION_CODES = new Set([3, 10, 200, 803]);

/**
 * Graph throttle codes: the app-level (#4), user-level (#17) and page-level
 * (#32) rate limits, plus #613 (a custom-rate-limit breach). The token is in
 * perfect health; the only fix is the next tick.
 */
const META_THROTTLE_CODES = new Set([4, 17, 32, 613]);

/**
 * True when a Meta failure means the TOKEN IS DEAD and only a reconnect fixes it.
 *
 * This is deliberately NOT `MetaGraphError.isAuthError`, and the difference is
 * the entire reason the predicate exists. classifyMetaError treats
 * `type: 'OAuthException'` as an auth error, and Meta stamps that type on far
 * more than dead tokens: a missing read_insights permission (#200), a missing
 * instagram_manage_insights (#10) and every rate limit (#4/#17/#32) all arrive
 * as OAuthException. On the PUBLISH path that reading is right and must stay —
 * publishing genuinely cannot proceed on any of them and the caller has to stop.
 * On the READ path it is a lie with a price attached: social-insights.service.ts
 * turns the flag into SocialAccount.lastError = 'reauth_required', and
 * social.tools.ts folds any string in that column into `needsReconnect`.
 *
 * The insights scopes at the top of this file are not in the OAuth config yet.
 * So without this narrowing, the FIRST hourly sweep after deploy tells every
 * workspace holding a Facebook Page or an IG Business account to reconnect an
 * account that publishes perfectly well — and sends them round an OAuth loop
 * that cannot grant a scope nobody asked for.
 *
 * The narrow question is: HTTP 401, code 190, or one of the session-invalidation
 * subcodes. The permission and throttle codes are excluded FIRST and explicitly
 * rather than left to fall through, because Meta is not consistent about the
 * HTTP status it pairs them with and a #200 that happens to arrive as a 401 must
 * still not condemn a working credential.
 *
 * The subcode list is NOT restated here. classifyMetaError already owns it, so
 * the subcode question is handed back to it in isolation: on a non-401 status
 * with no code and no type, its verdict IS the subcode verdict. One list, in one
 * file, that cannot drift from the one the publish path uses.
 *
 * Note what this does NOT do: a permission or throttle failure is still an
 * `ok:false` carrying the provider's own message, so it is recorded on the
 * account as `insightsError` and counted by the coverage report. It simply is
 * not allowed to say "reconnect".
 */
function isMetaReauthError(
  err: { httpStatus?: number; code?: number | null; subcode?: number | null } | null | undefined,
): boolean {
  if (!err) return false;
  const code = typeof err.code === 'number' ? err.code : null;
  if (code !== null && (META_PERMISSION_CODES.has(code) || META_THROTTLE_CODES.has(code))) return false;
  if (err.httpStatus === 401 || code === 190) return true;
  const subcode = typeof err.subcode === 'number' ? err.subcode : null;
  if (subcode === null) return false;
  return classifyMetaError(400, { error: { error_subcode: subcode } }).isAuthError;
}

/**
 * True when a network has ANY post/account insights endpoint we can call.
 *
 * Deliberately network-level and therefore coarse: a LinkedIn PERSONAL profile
 * is unreadable even though 'LINKEDIN' answers true here, because LinkedIn's
 * statistics APIs exist only for organizations. Callers that hold a whole
 * AccountRow get the precise answer from the fetch functions themselves (which
 * return `unsupported` for LI_PERSON); this predicate is for the cheap
 * "should I even bother enumerating this network" question.
 */
export function networkSupportsInsights(network: string): boolean {
  switch (network) {
    case 'FACEBOOK':
    case 'INSTAGRAM':
    case 'INSTAGRAM_LOGIN':
    case 'LINKEDIN':
    case 'TIKTOK':
    case 'TWITTER':
      return true;
    // Pinterest and Google Business Profile are publish-only for us today —
    // see the switch arms in fetchPostInsights for the exact endpoints that
    // would implement them.
    default:
      return false;
  }
}

// ───────────────────────────────────────────────────────────────── Facebook

/**
 * Facebook Page post insights.
 *
 * SCOPE: read_insights (plus the already-granted pages_read_engagement), and
 * the token must be the PAGE token — a user token returns an empty data array
 * rather than an error, which is why an empty payload is reported as an error
 * here instead of being stored as a row of zeros.
 *
 * Metric choice matches what the Page API actually exposes per post:
 *   post_impressions              — total renders
 *   post_impressions_unique       — reach (people, not renders)
 *   post_clicks                   — all consumptions (link, photo, other)
 *   post_reactions_by_type_total  — {like, love, wow, ...}; summed into `likes`
 *
 * `engagements` is DERIVED (reactions + clicks) rather than read, because the
 * one metric that would give it directly (post_engaged_users) is a separate
 * permission surface and is not in the set this integration asks for. Deriving
 * it is stated here so nobody later reads the column as provider-authoritative.
 */
async function facebookPostInsights(
  account: AccountRow,
  externalPostId: string,
): Promise<InsightsResult<PostInsights>> {
  if (!isNetworkConfigured('FACEBOOK')) {
    return failResult('Facebook not configured: set META_APP_ID and META_APP_SECRET');
  }
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    const r = await metaGraphFetch(`/${externalPostId}/insights`, {
      accessToken: token,
      query: {
        metric: 'post_impressions,post_impressions_unique,post_clicks,post_reactions_by_type_total',
      },
      timeoutMs: 15_000,
    });
    if (!r.ok) return failResult(`FB post insights: ${r.error.message}`, isMetaReauthError(r.error));
    const rows = r.data?.data;
    if (!Array.isArray(rows) || rows.length === 0) {
      return failResult('FB post insights: empty payload (page token / read_insights missing?)');
    }
    const likes = sumBreakdown(metaMetric(rows, 'post_reactions_by_type_total'));
    const clicks = num(metaMetric(rows, 'post_clicks'));
    return okResult({
      impressions: num(metaMetric(rows, 'post_impressions')),
      reach: num(metaMetric(rows, 'post_impressions_unique')),
      clicks,
      likes,
      engagements: likes + clicks,
      raw: r.data,
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Facebook post insights error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

/**
 * Facebook Page profile + daily page insights.
 *
 * SCOPE: read_insights for the /insights edge; the followers field comes from
 * the node itself and works with pages_read_engagement alone.
 *
 * TWO calls, and they fail INDEPENDENTLY on purpose. The follower count is the
 * number the account panel exists to show and it is available on the cheaper
 * permission; the day-level impressions/views live behind read_insights, which
 * most workspaces have not granted. Failing the whole account read because the
 * second call was denied would throw away the number we successfully got and
 * would make the account look broken. So the profile call is PRIMARY (its
 * failure fails the read) and the insights call is best-effort: its error is
 * preserved in `raw.insightsError`, which lands in SocialAccountMetric.raw, so
 * the reason for the missing columns is recorded in the row itself rather than
 * only in a log line nobody will read six weeks from now.
 */
async function facebookAccountInsights(account: AccountRow): Promise<InsightsResult<AccountInsights>> {
  if (!isNetworkConfigured('FACEBOOK')) {
    return failResult('Facebook not configured: set META_APP_ID and META_APP_SECRET');
  }
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    const prof = await metaGraphFetch(`/${account.externalId}`, {
      accessToken: token,
      query: { fields: 'followers_count,fan_count' },
      timeoutMs: 15_000,
    });
    if (!prof.ok) return failResult(`FB page: ${prof.error.message}`, isMetaReauthError(prof.error));
    // followers_count is the modern field; fan_count is the legacy "likes" and
    // is the only one some older Pages return. Either answers the question.
    const followers = num(prof.data?.followers_count ?? prof.data?.fan_count);

    const ins = await metaGraphFetch(`/${account.externalId}/insights`, {
      accessToken: token,
      query: { metric: 'page_impressions,page_views_total', period: 'day' },
      timeoutMs: 15_000,
    });
    if (!ins.ok) {
      logger.warn(`FB page insights degraded (${account.externalId}): ${ins.error.message}`);
      return okResult({
        followers,
        raw: { profile: prof.data, insightsError: ins.error.message },
      });
    }
    const rows = ins.data?.data;
    return okResult({
      followers,
      impressions: num(metaMetric(rows, 'page_impressions')),
      profileViews: num(metaMetric(rows, 'page_views_total')),
      raw: { profile: prof.data, insights: ins.data },
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Facebook page insights error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

// ────────────────────────────────────────────── Instagram (Page-linked, Meta)

/** Feed/carousel media metric set. */
const IG_FEED_METRICS = 'impressions,reach,saved,likes,comments,shares';
/**
 * Reels metric set. Reels do NOT support `impressions` or `saved` and the API
 * rejects the whole request with a 400 when an unsupported metric is present —
 * it does not skip the bad one. Since the media type is not stored on
 * SocialPostTarget, the only way to find out is to ask and be told.
 */
const IG_REEL_METRICS = 'plays,reach,likes,comments,shares,total_interactions';

/**
 * True when a Graph error is the "you asked for a metric this media type does
 * not have" 400 rather than a real failure. Meta returns this as a generic
 * code-100 with the offending metric named in the message, so the message is
 * the only thing to match on. Kept deliberately broad (any mention of metric
 * availability/support) because the exact wording has changed twice; a false
 * positive only costs one extra request with the other metric set.
 */
function isIgMetricMismatch(message: string): boolean {
  return /metric\[|does not support|not available|unsupported (get )?metric|invalid metric/i.test(message ?? '');
}

/**
 * Instagram media insights (IG Business via the Page-linked Graph).
 *
 * SCOPE: instagram_manage_insights. Without it every call here returns a
 * permission error and the whole feature is dark for Instagram; the connect
 * flow currently asks only for instagram_basic + instagram_content_publish.
 *
 * THE TWO METRIC SETS. The API 400s on the wrong set instead of ignoring the
 * unsupported metrics, and nothing in our schema records whether a given media
 * id is a Reel — the publisher knows (it chose REELS) but SocialPostTarget does
 * not persist it. So: try feed, and if the error is specifically a
 * metric-availability complaint, retry once with the Reels set. One wasted
 * request on Reels, never a wrong answer, and no schema change to carry a fact
 * the provider will tell us for free.
 */
async function instagramPostInsights(
  account: AccountRow,
  externalPostId: string,
): Promise<InsightsResult<PostInsights>> {
  if (!isNetworkConfigured('INSTAGRAM')) {
    return failResult('Instagram not configured: set META_APP_ID and META_APP_SECRET');
  }
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    let r = await metaGraphFetch(`/${externalPostId}/insights`, {
      accessToken: token,
      query: { metric: IG_FEED_METRICS },
      timeoutMs: 15_000,
    });
    if (!r.ok && isIgMetricMismatch(r.error.message)) {
      r = await metaGraphFetch(`/${externalPostId}/insights`, {
        accessToken: token,
        query: { metric: IG_REEL_METRICS },
        timeoutMs: 15_000,
      });
    }
    if (!r.ok) return failResult(`IG media insights: ${r.error.message}`, isMetaReauthError(r.error));
    const rows = r.data?.data;
    if (!Array.isArray(rows) || rows.length === 0) return failResult('IG media insights: empty payload');
    return okResult(mapIgMediaMetrics(rows, r.data));
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Instagram media insights error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

/**
 * Fold either metric set into one PostInsights. `plays` (Reels) is a video
 * view, not an impression, so it maps to videoViews and NOT to impressions —
 * summing the two across a mixed feed would double-count the same eyeball.
 * `total_interactions` is Instagram's own engagement roll-up when present;
 * otherwise engagements is derived from the four interaction counts.
 */
function mapIgMediaMetrics(rows: unknown, raw: unknown): PostInsights {
  const likes = num(metaMetric(rows, 'likes'));
  const comments = num(metaMetric(rows, 'comments'));
  const shares = num(metaMetric(rows, 'shares'));
  const saves = num(metaMetric(rows, 'saved'));
  const total = metaMetric(rows, 'total_interactions');
  return {
    impressions: num(metaMetric(rows, 'impressions')),
    reach: num(metaMetric(rows, 'reach')),
    videoViews: num(metaMetric(rows, 'plays')),
    likes,
    comments,
    shares,
    saves,
    engagements: total !== undefined ? num(total) : likes + comments + shares + saves,
    raw,
  };
}

/**
 * Instagram professional-account profile + daily account insights.
 * SCOPE: instagram_manage_insights for the /insights edge; followers_count and
 * media_count come off the node with instagram_basic.
 *
 * Same primary/best-effort split as the Facebook page read, for the same
 * reason: the follower number must survive a denied insights permission.
 */
async function instagramAccountInsights(account: AccountRow): Promise<InsightsResult<AccountInsights>> {
  if (!isNetworkConfigured('INSTAGRAM')) {
    return failResult('Instagram not configured: set META_APP_ID and META_APP_SECRET');
  }
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    const prof = await metaGraphFetch(`/${account.externalId}`, {
      accessToken: token,
      query: { fields: 'followers_count,media_count' },
      timeoutMs: 15_000,
    });
    if (!prof.ok) return failResult(`IG account: ${prof.error.message}`, isMetaReauthError(prof.error));
    const followers = num(prof.data?.followers_count);

    const ins = await metaGraphFetch(`/${account.externalId}/insights`, {
      accessToken: token,
      query: { metric: 'impressions,reach,profile_views', period: 'day' },
      timeoutMs: 15_000,
    });
    if (!ins.ok) {
      logger.warn(`IG account insights degraded (${account.externalId}): ${ins.error.message}`);
      return okResult({ followers, raw: { profile: prof.data, insightsError: ins.error.message } });
    }
    const rows = ins.data?.data;
    return okResult({
      followers,
      impressions: num(metaMetric(rows, 'impressions')),
      reach: num(metaMetric(rows, 'reach')),
      profileViews: num(metaMetric(rows, 'profile_views')),
      raw: { profile: prof.data, insights: ins.data },
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Instagram account insights error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

// ─────────────────────────────────────── Instagram (direct Instagram Login)

/**
 * graph.instagram.com speaks the same media-insights dialect as the Page-linked
 * Graph but is a DIFFERENT host with a DIFFERENT app (INSTAGRAM_APP_ID) and no
 * appsecret_proof, so it cannot go through metaGraphFetch — exactly the split
 * publishInstagramDirect already makes. Bearer token, plain safeFetch.
 *
 * SCOPE: instagram_business_manage_insights (the Instagram-Login flavour of
 * instagram_manage_insights); the connect flow asks only for
 * instagram_business_basic + instagram_business_content_publish today.
 */
async function igDirectGet(
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; json: any; status: number }> {
  const qs = new URLSearchParams(params).toString();
  const res = await safeFetch(`${IG_DIRECT_GRAPH}${path}?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  return { ok: res.ok, json, status: res.status };
}

/**
 * Same dead-token question as the Page-linked arm, asked of a raw
 * graph.instagram.com body: this host does not go through metaGraphFetch, so
 * there is no MetaGraphError to hand over — the fields are lifted out here and
 * the ONE predicate answers.
 *
 * It used to also treat `type: 'OAuthException'` as a dead token, which on this
 * host is even more wrong than it is on the other one: the Instagram-Login flow
 * has not asked for instagram_business_manage_insights at all, so EVERY
 * insights call it makes comes back as an OAuthException permission error, and
 * every one of them would have demanded a reconnect.
 */
function isIgDirectAuthError(status: number, json: any): boolean {
  const e = json?.error ?? {};
  return isMetaReauthError({
    httpStatus: status,
    code: typeof e.code === 'number' ? e.code : null,
    subcode: typeof e.error_subcode === 'number' ? e.error_subcode : null,
  });
}

async function instagramDirectPostInsights(
  account: AccountRow,
  externalPostId: string,
): Promise<InsightsResult<PostInsights>> {
  if (!isNetworkConfigured('INSTAGRAM_LOGIN')) {
    return failResult('Instagram (Login) not configured: set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET');
  }
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    let r = await igDirectGet(token, `/${externalPostId}/insights`, { metric: IG_FEED_METRICS });
    const firstMessage = String(r.json?.error?.message ?? '');
    if (!r.ok && isIgMetricMismatch(firstMessage)) {
      r = await igDirectGet(token, `/${externalPostId}/insights`, { metric: IG_REEL_METRICS });
    }
    if (!r.ok) {
      const msg = String(r.json?.error?.message ?? `HTTP ${r.status}`);
      return failResult(`IG media insights: ${msg}`, isIgDirectAuthError(r.status, r.json));
    }
    const rows = r.json?.data;
    if (!Array.isArray(rows) || rows.length === 0) return failResult('IG media insights: empty payload');
    return okResult(mapIgMediaMetrics(rows, r.json));
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Instagram (Login) media insights error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

/**
 * Instagram-Login account read. Only the node fields are available on this
 * flavour — the /insights edge exists but is gated behind the same
 * business-insights grant, so followers_count is the one number we can rely on
 * and the account snapshot is built from it alone.
 */
async function instagramDirectAccountInsights(account: AccountRow): Promise<InsightsResult<AccountInsights>> {
  if (!isNetworkConfigured('INSTAGRAM_LOGIN')) {
    return failResult('Instagram (Login) not configured: set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET');
  }
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    const r = await igDirectGet(token, `/${account.externalId}`, { fields: 'followers_count,media_count' });
    if (!r.ok) {
      const msg = String(r.json?.error?.message ?? `HTTP ${r.status}`);
      return failResult(`IG account: ${msg}`, isIgDirectAuthError(r.status, r.json));
    }
    return okResult({ followers: num(r.json?.followers_count), raw: r.json });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`Instagram (Login) account insights error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

// ───────────────────────────────────────────────────────────────── LinkedIn

/**
 * Build the share/ugcPost URN filter for organizationalEntityShareStatistics.
 *
 * What we stored as externalPostId is the `x-restli-id` the versioned Posts API
 * returned, which is already a full URN (`urn:li:share:123` for a plain post,
 * `urn:li:ugcPost:123` for one carrying media). The statistics endpoint takes
 * the two kinds under DIFFERENT parameter names, so the URN type selects the
 * parameter. A bare numeric id (older rows, or a hand-entered account) is
 * treated as a share, which is what the Posts API returns by default.
 */
function linkedinShareFilter(externalPostId: string): { key: 'shares' | 'ugcPosts'; urn: string } {
  const id = String(externalPostId);
  if (id.includes('ugcPost')) return { key: 'ugcPosts', urn: id };
  if (id.startsWith('urn:li:share:')) return { key: 'shares', urn: id };
  return { key: 'shares', urn: `urn:li:share:${id}` };
}

/**
 * LinkedIn organization share statistics.
 *
 * SCOPE: r_organization_social — part of the Community Management API, which
 * needs LinkedIn partner review. scopesFor() in social-oauth.config.ts already
 * strips the org scopes unless LINKEDIN_ORG_SCOPES is set, so on a self-serve
 * app this call will correctly report a permission error rather than data.
 *
 * PERSONAL PROFILES ARE UNSUPPORTED, PERMANENTLY. LinkedIn publishes no member
 * share-statistics API at any tier — the numbers a member sees on linkedin.com
 * are not exposed to third parties. That is a fact about LinkedIn, not a gap in
 * our grant, so LI_PERSON returns `unsupported` (nothing to retry, nothing to
 * ask for) instead of an error that would sit in the coverage report forever.
 *
 * `engagement` in the response is deliberately NOT mapped to `engagements`: it
 * is a RATE (0..1), not a count, and storing it in an integer count column
 * would floor it to 0 on every row. The count is derived from the four
 * interaction fields instead.
 */
async function linkedinPostInsights(
  account: AccountRow,
  externalPostId: string,
): Promise<InsightsResult<PostInsights>> {
  if (!isNetworkConfigured('LINKEDIN')) {
    return failResult('LinkedIn not configured: set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET');
  }
  if (account.accountType !== 'LI_ORG') return unsupportedResult();
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    const filter = linkedinShareFilter(externalPostId);
    const r = await linkedinRest('/rest/organizationalEntityShareStatistics', {
      accessToken: token,
      method: 'GET',
      query: {
        q: 'organizationalEntity',
        organizationalEntity: `urn:li:organization:${account.externalId}`,
        // Rest.li list syntax. Left UNencoded here on purpose: linkedinRest
        // builds the query through URLSearchParams, which percent-encodes it
        // once; pre-encoding would double-encode the colons in the URN.
        [filter.key]: `List(${filter.urn})`,
      },
    });
    if (!r.ok) return failResult(`LinkedIn share stats: ${r.error.message}`, r.error.isAuthError);
    const stats = r.data?.elements?.[0]?.totalShareStatistics;
    if (!stats) return failResult('LinkedIn share stats: no statistics for this share yet');
    const likes = num(stats.likeCount);
    const comments = num(stats.commentCount);
    const shares = num(stats.shareCount);
    const clicks = num(stats.clickCount);
    return okResult({
      impressions: num(stats.impressionCount),
      reach: num(stats.uniqueImpressionsCount),
      likes,
      comments,
      shares,
      clicks,
      engagements: likes + comments + shares + clicks,
      raw: r.data,
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`LinkedIn share stats error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

/**
 * LinkedIn organization follower count + page views.
 *
 * networkSizes is the follower count and is the PRIMARY call. organizationPage
 * Statistics carries page views and needs the heavier admin grant, so it is
 * best-effort exactly like the Meta page-insights call: its failure is recorded
 * in raw.pageStatsError and the follower number still lands.
 */
async function linkedinAccountInsights(account: AccountRow): Promise<InsightsResult<AccountInsights>> {
  if (!isNetworkConfigured('LINKEDIN')) {
    return failResult('LinkedIn not configured: set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET');
  }
  if (account.accountType !== 'LI_ORG') return unsupportedResult();
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  const orgUrn = `urn:li:organization:${account.externalId}`;
  try {
    const sizes = await linkedinRest(`/rest/networkSizes/${encodeURIComponent(orgUrn)}`, {
      accessToken: token,
      method: 'GET',
      query: { edgeType: 'CompanyFollowedByMember' },
    });
    if (!sizes.ok) return failResult(`LinkedIn networkSizes: ${sizes.error.message}`, sizes.error.isAuthError);
    const followers = num(sizes.data?.firstDegreeSize);

    const page = await linkedinRest('/rest/organizationPageStatistics', {
      accessToken: token,
      method: 'GET',
      query: { q: 'organization', organization: orgUrn },
    });
    if (!page.ok) {
      logger.warn(`LinkedIn page stats degraded (${account.externalId}): ${page.error.message}`);
      return okResult({ followers, raw: { networkSizes: sizes.data, pageStatsError: page.error.message } });
    }
    const views = page.data?.elements?.[0]?.totalPageStatistics?.views?.allPageViews?.pageViews;
    return okResult({
      followers,
      profileViews: num(views),
      raw: { networkSizes: sizes.data, pageStatistics: page.data },
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`LinkedIn account insights error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

// ─────────────────────────────────────────────────────────────────── TikTok

const TIKTOK_API = 'https://open.tiktokapis.com';

/**
 * TikTok signals a dead/absent token with an `error.code` string rather than a
 * numeric one, and its 401s are inconsistent — the Display API answers 200 with
 * an error body on some failures. `scope_not_authorized` is deliberately NOT
 * treated as auth: the token is fine, the app simply was not granted video.list
 * or user.info.stats, and telling the operator to reconnect would send them
 * round a loop that cannot fix it.
 */
function isTiktokAuthError(status: number, json: any): boolean {
  const code = String(json?.error?.code ?? '');
  return (
    status === 401 ||
    /access_token_invalid|access_token_expired|token_revoked/i.test(code) ||
    /^4010\d$/.test(code)
  );
}

async function tiktokFetch(
  token: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<{ ok: boolean; json: any; status: number }> {
  const res = await safeFetch(`${TIKTOK_API}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    timeoutMs: 15_000,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  // TikTok answers HTTP 200 with `error.code: 'ok'` on success and a non-'ok'
  // code on failure — an HTTP-status-only check would read a scope rejection as
  // a successful empty result, so both are required.
  const code = String(json?.error?.code ?? 'ok');
  return { ok: res.ok && (code === 'ok' || code === ''), json, status: res.status };
}

/**
 * Turn what publishTikTok STORED into something the video API can query.
 *
 * This is the one place where the read path cannot simply use externalPostId,
 * and it is worth being explicit about why. The Content Posting API is
 * asynchronous: init returns a `publish_id` and TikTok finishes the encode on
 * its own schedule, so the publisher stores the publish_id — it is the only id
 * that exists at publish time. The Display API's /v2/video/query/ knows nothing
 * about publish ids; it takes VIDEO ids. The bridge between them is the publish
 * status endpoint, which reports `publicaly_available_post_id` (TikTok's
 * spelling, not ours) once the post is live.
 *
 * So: an id that still looks like a publish handle (`v_pub_...` / `v_inbox_...`)
 * is resolved through status/fetch first; anything else is assumed to already
 * be a video id. Returns null when the post is not publicly available yet,
 * which is a legitimate not-ready state rather than a failure.
 */
async function resolveTiktokVideoId(token: string, externalPostId: string): Promise<string | null> {
  if (!/^v_(pub|inbox)/i.test(externalPostId)) return externalPostId;
  const r = await tiktokFetch(token, '/v2/post/publish/status/fetch/', {
    method: 'POST',
    body: { publish_id: externalPostId },
  });
  if (!r.ok) return null;
  const ids = r.json?.data?.publicaly_available_post_id;
  const first = Array.isArray(ids) ? ids[0] : undefined;
  return first != null ? String(first) : null;
}

/**
 * TikTok video statistics.
 * SCOPE: video.list. The connect flow asks for user.info.basic + video.publish
 * only, so this returns a scope error until video.list is added and approved.
 */
async function tiktokPostInsights(
  account: AccountRow,
  externalPostId: string,
): Promise<InsightsResult<PostInsights>> {
  if (!isNetworkConfigured('TIKTOK')) {
    return failResult('TikTok not configured: set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET');
  }
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    const videoId = await resolveTiktokVideoId(token, externalPostId);
    if (!videoId) return failResult('TikTok: post is not publicly available yet (still processing)');

    const r = await tiktokFetch(
      token,
      '/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count',
      { method: 'POST', body: { filters: { video_ids: [videoId] } } },
    );
    if (!r.ok) {
      const msg = String(r.json?.error?.message ?? r.json?.error?.code ?? `HTTP ${r.status}`);
      return failResult(`TikTok video query: ${msg}`, isTiktokAuthError(r.status, r.json));
    }
    const video = r.json?.data?.videos?.[0];
    if (!video) return failResult('TikTok video query: video not found (deleted or not yet indexed)');
    const likes = num(video.like_count);
    const comments = num(video.comment_count);
    const shares = num(video.share_count);
    return okResult({
      // TikTok reports plays, not renders — a view is the closest thing it has
      // to an impression, and it is stored in BOTH so a mixed-network chart can
      // use impressions while a video report can use videoViews.
      impressions: num(video.view_count),
      videoViews: num(video.view_count),
      likes,
      comments,
      shares,
      engagements: likes + comments + shares,
      raw: r.json,
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`TikTok video query error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

/**
 * TikTok creator statistics.
 * SCOPE: user.info.stats (follower_count / likes_count / video_count). The
 * already-granted user.info.basic returns the profile WITHOUT any of them.
 */
async function tiktokAccountInsights(account: AccountRow): Promise<InsightsResult<AccountInsights>> {
  if (!isNetworkConfigured('TIKTOK')) {
    return failResult('TikTok not configured: set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET');
  }
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    const r = await tiktokFetch(
      token,
      '/v2/user/info/?fields=follower_count,likes_count,video_count',
      { method: 'GET' },
    );
    if (!r.ok) {
      const msg = String(r.json?.error?.message ?? r.json?.error?.code ?? `HTTP ${r.status}`);
      return failResult(`TikTok user info: ${msg}`, isTiktokAuthError(r.status, r.json));
    }
    const user = r.json?.data?.user ?? {};
    return okResult({ followers: num(user.follower_count), raw: r.json });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`TikTok user info error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

// ────────────────────────────────────────────────────────────────── X (Twitter)

const X_API = 'https://api.twitter.com';

async function xFetch(token: string, path: string): Promise<{ ok: boolean; json: any; status: number }> {
  const res = await safeFetch(`${X_API}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
  });
  const json = (await res.json().catch(() => ({}))) as any;
  return { ok: res.ok, json, status: res.status };
}

/** X states failures in `detail`/`title`; 401 is the dead-token signal. */
function xError(json: any, status: number): string {
  return String(json?.detail ?? json?.title ?? json?.errors?.[0]?.message ?? `HTTP ${status}`);
}

/**
 * Tweet public metrics.
 * SCOPE: tweet.read — already requested by the connect flow, so X is the one
 * network where insights should work the day it is connected.
 *
 * `impression_count` is only returned for tweets the AUTHENTICATED user
 * authored, which is exactly our case (we published them). Bookmarks map to
 * `saves` because that is what a bookmark is; quote tweets are counted as
 * shares alongside retweets since both are a redistribution of the post.
 */
async function twitterPostInsights(
  account: AccountRow,
  externalPostId: string,
): Promise<InsightsResult<PostInsights>> {
  if (!isNetworkConfigured('TWITTER')) {
    return failResult('X/Twitter not configured: set X_CLIENT_ID and X_CLIENT_SECRET');
  }
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    const r = await xFetch(token, `/2/tweets/${encodeURIComponent(externalPostId)}?tweet.fields=public_metrics`);
    if (!r.ok) return failResult(`X tweet metrics: ${xError(r.json, r.status)}`, r.status === 401);
    const m = r.json?.data?.public_metrics;
    if (!m) return failResult('X tweet metrics: no public_metrics on the response');
    const likes = num(m.like_count);
    const comments = num(m.reply_count);
    const shares = num(m.retweet_count) + num(m.quote_count);
    const saves = num(m.bookmark_count);
    return okResult({
      impressions: num(m.impression_count),
      likes,
      comments,
      shares,
      saves,
      engagements: likes + comments + shares + saves,
      raw: r.json,
    });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`X tweet metrics error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

/**
 * X account metrics. Uses /2/users/me rather than /2/users/{id} deliberately:
 * the sealed token IS the account's own user token, so "me" needs no id and
 * cannot drift if externalId was ever stored as a handle instead of a numeric
 * id. SCOPE: users.read — already requested.
 */
async function twitterAccountInsights(account: AccountRow): Promise<InsightsResult<AccountInsights>> {
  if (!isNetworkConfigured('TWITTER')) {
    return failResult('X/Twitter not configured: set X_CLIENT_ID and X_CLIENT_SECRET');
  }
  const token = revealToken(account);
  if (!token) return failResult('accessToken could not be decrypted');
  try {
    const r = await xFetch(token, '/2/users/me?user.fields=public_metrics');
    if (!r.ok) return failResult(`X user metrics: ${xError(r.json, r.status)}`, r.status === 401);
    const m = r.json?.data?.public_metrics;
    if (!m) return failResult('X user metrics: no public_metrics on the response');
    return okResult({ followers: num(m.followers_count), raw: r.json });
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`X user metrics error (${account.externalId}): ${msg}`);
    return failResult(msg);
  }
}

// ─────────────────────────────────────────────────────────────────── Dispatch

/**
 * Read one published post's counts. Mirrors publishToNetwork's dispatch switch
 * arm-for-arm so the two files stay comparable at a glance; every arm is
 * individually try/caught inside its own function and this wrapper adds a final
 * net, because a sweep over hundreds of accounts must not die on one of them.
 */
export async function fetchPostInsights(
  account: AccountRow,
  externalPostId: string,
): Promise<InsightsResult<PostInsights>> {
  if (!externalPostId) return failResult('no externalPostId on this target');
  try {
    switch (account.network) {
      case 'FACEBOOK':
        return await facebookPostInsights(account, externalPostId);
      case 'INSTAGRAM':
        return await instagramPostInsights(account, externalPostId);
      case 'INSTAGRAM_LOGIN':
        return await instagramDirectPostInsights(account, externalPostId);
      case 'LINKEDIN':
        return await linkedinPostInsights(account, externalPostId);
      case 'TIKTOK':
        return await tiktokPostInsights(account, externalPostId);
      case 'TWITTER':
        return await twitterPostInsights(account, externalPostId);
      // Pinterest DOES publish pin analytics —
      // GET /v5/pins/{pin_id}/analytics?start_date=&end_date=&metric_types=
      // IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK — but it requires the
      // pins:read + user_accounts:read scopes AND a business account, neither of
      // which the current connect flow establishes. Left unsupported rather than
      // half-wired so the coverage report stays honest.
      case 'PINTEREST':
        return unsupportedResult();
      // Google Business Profile post performance lives in the separate
      // Business Profile Performance API —
      // POST /v1/{location}:fetchMultiDailyMetricsTimeSeries with
      // dailyMetrics=BUSINESS_IMPRESSIONS_* — and is location-level, not
      // per-local-post; there is no per-post metrics edge at all. Unsupported.
      case 'GMB':
        return unsupportedResult();
      default:
        return failResult(`Unknown network: ${account.network}`);
    }
  } catch (e: any) {
    // Belt and braces: safeFetch THROWS on SSRF-block, DNS failure, ECONNRESET
    // and timeout. Every arm already catches, but a sweep must be unkillable.
    const msg = e?.message ?? String(e);
    logger.warn(`post insights dispatch error (${account.network}/${account.id}): ${msg}`);
    return failResult(msg);
  }
}

/** Read one account's profile-level counts. Same contract as fetchPostInsights. */
export async function fetchAccountInsights(account: AccountRow): Promise<InsightsResult<AccountInsights>> {
  try {
    switch (account.network) {
      case 'FACEBOOK':
        return await facebookAccountInsights(account);
      case 'INSTAGRAM':
        return await instagramAccountInsights(account);
      case 'INSTAGRAM_LOGIN':
        return await instagramDirectAccountInsights(account);
      case 'LINKEDIN':
        return await linkedinAccountInsights(account);
      case 'TIKTOK':
        return await tiktokAccountInsights(account);
      case 'TWITTER':
        return await twitterAccountInsights(account);
      // Pinterest: GET /v5/user_account/analytics?start_date=&end_date=&
      // metric_types=IMPRESSION,SAVE would give account-level counts, and
      // GET /v5/user_account gives follower_count — both behind
      // user_accounts:read, which we do not request. Unsupported for now.
      case 'PINTEREST':
        return unsupportedResult();
      // GMB: POST /v1/{location}:fetchMultiDailyMetricsTimeSeries (Business
      // Profile Performance API) covers views/searches, but the API is
      // allowlist-gated by Google and the whole GMB adapter is inert until then.
      case 'GMB':
        return unsupportedResult();
      default:
        return failResult(`Unknown network: ${account.network}`);
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    logger.warn(`account insights dispatch error (${account.network}/${account.id}): ${msg}`);
    return failResult(msg);
  }
}
