// backend/src/common/util/linkedin-api.util.ts
import { safeFetch } from './safe-fetch';

/**
 * Thin versioned client for the LinkedIn REST API (api.linkedin.com/rest/*).
 * Plain module (NOT a Nest provider) so tests mock `safeFetch` at the module
 * seam — mirrors meta-graph.util.ts. Returns a FLAT result (data + error both
 * always present, error null iff ok) because the repo's tsconfig has
 * strictNullChecks:false and cannot narrow discriminated unions.
 *
 * Every /rest call needs: Authorization: Bearer, LinkedIn-Version: YYYYMM,
 * X-Restli-Protocol-Version: 2.0.0. Created entities return their id/urn in the
 * `x-restli-id` RESPONSE header (not the body). HTTP 401 = token invalid →
 * reauth; 403 = insufficient permission / partner-gating → plain error.
 */
const API_BASE = 'https://api.linkedin.com';

/**
 * THE one place the LinkedIn API version lives. Every /rest call — publishing,
 * ads read + write, audiences, insights, engagement polling — reads it through
 * `linkedinApiVersion()`, so moving off a sunset version is a one-line change
 * here, or a LINKEDIN_API_VERSION override with no code change at all
 * (deploy.yml renders that var into the prod env from a repo Variable).
 *
 * WHAT WE KNOW, from our own production logs and nothing else: LinkedIn dates
 * versions YYYYMM, it stops serving old ones, and a call carrying one it no
 * longer serves is rejected outright with `Requested version <YYYYMM>01 is not
 * active`. That error, against `202406`, is what broke every LinkedIn publish
 * in production and is the whole reason this constant exists.
 *
 * WHAT WE DO NOT KNOW — and this is the important half. `202606` below is a
 * well-formed YYYYMM that is newer than the 202406 we have evidence is retired,
 * AND NOTHING MORE. It was picked in an offline session with no network access:
 * nobody has checked it against LinkedIn's published version list, so it is
 * UNVERIFIED. Two things must be confirmed against LinkedIn's own versioning /
 * changelog documentation BEFORE this ships:
 *   1. that 202606 is a version LinkedIn actually publishes and still serves;
 *   2. that the request bodies in this repo — written and last exercised against
 *      202406 — are still shaped correctly under it (/rest/posts,
 *      /rest/images?action=initializeUpload, /rest/videos finalize,
 *      /rest/adAnalytics finder params, /rest/adCampaigns PARTIAL_UPDATE).
 * If either turns out wrong, the fix needs no CODE change: set the
 * LINKEDIN_API_VERSION repo Variable and re-run the deploy (or edit the server's
 * env file and restart) — deploy.yml renders it, so it takes effect either way.
 */
export const LINKEDIN_DEFAULT_API_VERSION = '202606';

/**
 * The configured version, or the default. The env override must be a real
 * YYYYMM: a well-formed-but-impossible month (202413) or the full YYYYMMDD form
 * LinkedIn echoes in its own error text (20240601) would be rejected by the API
 * exactly like a retired version, so they fall back rather than ship a request
 * that cannot succeed.
 */
export function linkedinApiVersion(): string {
  const v = process.env.LINKEDIN_API_VERSION;
  return v && /^\d{4}(0[1-9]|1[0-2])$/.test(v) ? v : LINKEDIN_DEFAULT_API_VERSION;
}

export interface LinkedinError {
  message: string;
  status: number;
  serviceErrorCode: number | null;
  isAuthError: boolean;
  raw: unknown;
}

export interface LinkedinResult {
  ok: boolean;
  status: number;
  data: any;
  /** Value of the `x-restli-id` response header on creates (urn/id), else null. */
  restliId: string | null;
  error: LinkedinError | null;
}

export interface LinkedinFetchOptions {
  accessToken: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  version?: string;
  timeoutMs?: number;
  /**
   * Extra request headers, merged over the three every /rest call carries.
   * Exists for rest.li's method override (`X-RestLi-Method: PARTIAL_UPDATE`),
   * which some write endpoints require and which used to force callers to
   * hand-roll the whole request over safeFetch — and so to lose this module's
   * error classification and its operator-facing version message with it.
   * `Content-Type` is NOT overridable: a body is always sent as JSON.
   */
  headers?: Record<string, string>;
}

/**
 * True when the error/result represents a LinkedIn token failure needing
 * reconnect. Accepts a thrown Error with `isAuthError`, a LinkedinError, or a
 * whole LinkedinResult (mirrors isMetaAuthError's tri-shape acceptance).
 */
export function isLinkedinAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const o = err as any;
  if (o.isAuthError === true) return true;
  if (o.ok === false && o.error && o.error.isAuthError === true) return true;
  return false;
}

/**
 * Detects LinkedIn's version rejection from the raw response. The observed text
 * is `Requested version 20240601 is not active` (LinkedIn echoes the version as
 * YYYYMM01); HTTP 426 Upgrade Required is the status it arrives with. Matched on
 * the message primarily, since the status alone is not documented as exclusive
 * to this case.
 *
 * DELIBERATELY NOT EXPORTED, and there is no `isVersionError` flag on
 * LinkedinError either. Both existed and had no production caller — only specs.
 * A branch on them would have been a no-op guard rather than a behaviour: every
 * LinkedIn auth classification in this repo is `status === 401` exactly
 * (linkedinRest here, `isLinkedinPermissionError` in network-insights.ts,
 * `updateLinkedinCampaign`, `linkedin-audience.client`), so a 426 already
 * cannot be mistaken for an auth/reconnect condition anywhere — not in
 * `ad-account.service`'s markReauth, not in `ad-management.onResult`, not in
 * `social-insights`'s `stamp()`, which writes `lastError` only on `authFailed`.
 * What a caller actually needs is the SENTENCE, and that it gets: the classifier
 * earns its keep below by turning the rejection into a message naming the
 * version sent and the knob that moves it, which is what reaches a human via
 * `SocialPostTarget.error` and `AdAccount.lastError`. If a caller ever needs to
 * branch rather than print, re-adding the flag is one line.
 */
function detectVersionError(status: number, data: any): boolean {
  const text = typeof data?.message === 'string' ? data.message : '';
  if (/version\s+\d{6,8}\s+is\s+not\s+active/i.test(text)) return true;
  if (/\bis not active\b/i.test(text) && /version/i.test(text)) return true;
  return status === 426;
}

export async function linkedinRest(path: string, opts: LinkedinFetchOptions): Promise<LinkedinResult> {
  const {
    accessToken,
    method = 'GET',
    query,
    body,
    version,
    timeoutMs = 15_000,
    headers: extraHeaders,
  } = opts;
  const url = new URL(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const sentVersion = version ?? linkedinApiVersion();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'LinkedIn-Version': sentVersion,
    'X-Restli-Protocol-Version': '2.0.0',
    ...(extraHeaders ?? {}),
  };
  const init: Record<string, unknown> = { method, headers, timeoutMs };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await safeFetch(url.toString(), init as any);
  } catch (e: any) {
    return {
      ok: false,
      status: 0,
      data: null,
      restliId: null,
      error: {
        message: e?.message ?? 'network error',
        status: 0,
        serviceErrorCode: null,
        isAuthError: false,
        raw: e,
      },
    };
  }

  const restliId = res.headers?.get?.('x-restli-id') ?? null;
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (res.ok) {
    return { ok: true, status: res.status, data, restliId, error: null };
  }

  // 401 = invalid/expired token → reauth. 403 = permission/partner-gating → NOT reauth.
  const isAuthError = res.status === 401;
  const serviceErrorCode = typeof data?.serviceErrorCode === 'number' ? data.serviceErrorCode : null;
  const raw = String(data?.message ?? `LinkedIn HTTP ${res.status}`);
  // A retired version fails EVERY LinkedIn call and is fixed by config, not by the
  // user — so say which version went out and which knob moves it, right in the
  // message the publish path stores on the failed target and shows the operator.
  // The knob is real: deploy.yml renders LINKEDIN_API_VERSION into the prod env
  // (empty by default, so this constant applies unless the Variable is set).
  const message = detectVersionError(res.status, data)
    ? `LinkedIn API version ${sentVersion} is not active (retired) — set LINKEDIN_API_VERSION to a version LinkedIn still serves (YYYYMM): ${raw}`
    : raw;
  return {
    ok: false,
    status: res.status,
    data,
    restliId: null,
    error: { message, status: res.status, serviceErrorCode, isAuthError, raw: data },
  };
}

/** PUT raw bytes to a LinkedIn dms-uploads URL (no LinkedIn headers). Returns the etag (= uploaded part id for videos). */
export async function linkedinUpload(
  uploadUrl: string,
  bytes: Buffer,
  contentType = 'application/octet-stream',
): Promise<{ ok: boolean; etag: string | null; status: number }> {
  const res = await safeFetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
    timeoutMs: 60_000,
  } as any);
  return { ok: res.ok, etag: res.headers?.get?.('etag') ?? null, status: res.status };
}
