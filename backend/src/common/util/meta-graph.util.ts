import { createHmac } from 'node:crypto';
import { safeFetch } from './safe-fetch';

/**
 * Shared Meta Graph client for every Meta call site (messaging adapters, social
 * publishing, ads insights, review sync). Centralizes:
 *  - the base URL + a configurable Graph API version (env GRAPH_API_VERSION),
 *  - mandatory `appsecret_proof` on every authenticated call (Meta's
 *    "Require app secret proof for server API calls" defaults to ON — without it
 *    those apps return opaque 400s),
 *  - transport via the SSRF-safe `safeFetch`,
 *  - a uniform parsed error shape + an auth-error predicate that drives the
 *    reauth_required / TOKEN_EXPIRED surfacing across sub-systems.
 *
 * Kept a PLAIN module (not a Nest provider) so it mocks like safe-fetch and
 * imports cleanly into all features. NEVER throws on a missing secret — it
 * omits the proof so dev/inert deploys still function (the inert-feature rule).
 */

/** Graph API version from env, defaulting to v19.0. Invalid values fall back. */
export function graphApiVersion(): string {
  const v = process.env.GRAPH_API_VERSION;
  return v && /^v\d+\.\d+$/.test(v) ? v : 'v19.0';
}

/** `https://graph.facebook.com/<version>` */
export function graphBaseUrl(): string {
  return `https://graph.facebook.com/${graphApiVersion()}`;
}

/**
 * Lowercase-hex HMAC-SHA256 of the access token keyed by META_APP_SECRET.
 * Returns null (never throws) when the secret or the token is absent so callers
 * simply omit the param when the app is unconfigured.
 */
export function appSecretProof(accessToken: string | null | undefined): string | null {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !accessToken) return null;
  return createHmac('sha256', secret).update(accessToken).digest('hex');
}

export interface MetaGraphError {
  httpStatus: number;
  code: number | null;
  subcode: number | null;
  fbtraceId: string | null;
  message: string;
  /** True when the failure is a token problem the operator must reconnect for. */
  isAuthError: boolean;
}

/**
 * Flat result (not a discriminated union) on purpose: this project sets
 * `strictNullChecks: false`, under which TS does NOT narrow `{ok:true}|{ok:false}`
 * via `if (!x.ok)`. A single interface where `data` and `error` always exist
 * (error is null iff ok) is bulletproof for every consumer.
 */
export interface MetaGraphResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body — the data on success, or the raw error body on failure. */
  data: any;
  /** Populated only when `ok` is false; null otherwise. */
  error: MetaGraphError | null;
}

/** Graph error_subcodes meaning the token/session is invalid → needs reauth. */
const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);

/** Normalize a Graph error body + HTTP status into our uniform shape. */
export function classifyMetaError(httpStatus: number, body: any): MetaGraphError {
  const e = (body && body.error) || {};
  const code = typeof e.code === 'number' ? e.code : null;
  const subcode = typeof e.error_subcode === 'number' ? e.error_subcode : null;
  const isAuthError =
    httpStatus === 401 ||
    code === 190 ||
    e.type === 'OAuthException' ||
    (subcode != null && AUTH_SUBCODES.has(subcode));
  return {
    httpStatus,
    code,
    subcode,
    fbtraceId: typeof e.fbtrace_id === 'string' ? e.fbtrace_id : null,
    message: String(e.message ?? body?.error_description ?? `HTTP ${httpStatus}`).slice(0, 300),
    isAuthError,
  };
}

/**
 * True when an error/result represents a Meta auth failure (token expired,
 * revoked, password changed, app removed). Accepts a MetaGraphError, a
 * MetaGraphResult, or any thrown Error carrying an `isAuthError` flag.
 */
export function isMetaAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const o = err as any;
  if (o.isAuthError === true) return true;
  if (o.ok === false && o.error && o.error.isAuthError === true) return true;
  return false;
}

export interface MetaGraphFetchOptions {
  /** Access token; placed in the query (+proof) unless `bearer` is set. */
  accessToken?: string | null;
  method?: string;
  /** Extra query params (access_token + appsecret_proof are added for you). */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body (object) — serialized + content-type set. */
  body?: unknown;
  /** Send the token as `Authorization: Bearer` (WhatsApp Cloud style). The
   *  appsecret_proof is still appended to the query (harmless if not required). */
  bearer?: boolean;
  /** Hard timeout in ms (default 10s). */
  timeoutMs?: number;
}

/** Authenticated Graph call: assembles URL (+access_token+proof), transports, parses. */
export async function metaGraphFetch(
  path: string,
  opts: MetaGraphFetchOptions = {},
): Promise<MetaGraphResult> {
  const { accessToken, method = 'GET', query = {}, body, bearer = false, timeoutMs = 10_000 } = opts;
  const url = new URL(`${graphBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  if (accessToken && !bearer) url.searchParams.set('access_token', accessToken);
  if (accessToken) {
    const proof = appSecretProof(accessToken);
    if (proof) url.searchParams.set('appsecret_proof', proof);
  }
  const headers: Record<string, string> = {};
  if (bearer && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const init: Record<string, unknown> = { method, timeoutMs, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return runGraph(url.toString(), init);
}

/**
 * Follow a provider-issued absolute `paging.next` URL (which already carries
 * access_token + cursor): (re)apply appsecret_proof so page 2+ still verifies
 * under required-proof apps, then transport.
 */
export async function metaGraphFollow(
  absoluteNextUrl: string,
  accessToken: string,
  timeoutMs = 10_000,
): Promise<MetaGraphResult> {
  const url = new URL(absoluteNextUrl);
  const proof = appSecretProof(accessToken);
  if (proof) url.searchParams.set('appsecret_proof', proof);
  return runGraph(url.toString(), { method: 'GET', timeoutMs });
}

async function runGraph(url: string, init: Record<string, unknown>): Promise<MetaGraphResult> {
  const res = await safeFetch(url, init as any);
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, status: res.status, data: json, error: classifyMetaError(res.status, json) };
  }
  return { ok: true, status: res.status, data: json, error: null };
}
