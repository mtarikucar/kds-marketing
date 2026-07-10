import { safeFetch } from '../../../common/util/safe-fetch';

/**
 * Shared Google Ads REST helper for every Google Ads call site (insights pull,
 * campaign write, offline click-conversion upload). The Google analog of
 * meta-graph.util — centralizes:
 *  - the base URL + a configurable API version (env GOOGLE_ADS_API_VERSION),
 *  - the OAuth refresh-token → short-lived access-token exchange Google needs
 *    (unlike Meta/TikTok/LinkedIn, Google does NOT store a long-lived token; a
 *    ~1h access token is minted per call from the sealed refresh token, cached
 *    in-memory keyed by refresh token so a burst of calls re-uses one),
 *  - the three mandatory headers (Authorization: Bearer + developer-token +
 *    login-customer-id) assembled uniformly,
 *  - transport via the SSRF-safe `safeFetch`,
 *  - a uniform parsed result/error shape + an auth-error predicate that drives
 *    the reauth_required / TOKEN_EXPIRED surfacing across sub-systems.
 *
 * Kept a PLAIN module (not a Nest provider) so it mocks like safe-fetch and
 * imports cleanly into all features. NEVER throws on missing platform creds — it
 * omits the header so dev/inert deploys still function (the inert-feature rule).
 */

/** Google's OAuth 2.0 token endpoint (refresh-token grant). */
export const GOOGLE_ADS_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** API version from env, defaulting to v17. Invalid values fall back. */
export function googleAdsApiVersion(): string {
  const v = process.env.GOOGLE_ADS_API_VERSION;
  return v && /^v\d+$/.test(v) ? v : 'v17';
}

/** `https://googleads.googleapis.com/<version>` */
export function googleAdsBaseUrl(): string {
  return `https://googleads.googleapis.com/${googleAdsApiVersion()}`;
}

/** Customer / login-customer ids are all-digits (no dashes) on the wire. */
export function normalizeCustomerId(id: string | null | undefined): string {
  return String(id ?? '').replace(/\D/g, '');
}

// ── Access-token cache ──────────────────────────────────────────────────────
// Keyed by refresh token so concurrent calls for the same account share one
// mint. Re-minted `TOKEN_SKEW_MS` before the real expiry to avoid using a token
// that expires mid-flight. Module-level (process-lifetime) — the same shape a
// production deploy wants; NEVER persisted (a fresh access token is cheap).
interface CachedAccessToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}
const tokenCache = new Map<string, CachedAccessToken>();
const TOKEN_SKEW_MS = 60_000;

/**
 * Exchange a sealed-then-opened refresh token for a short-lived access token
 * (cached until ~1 min before expiry). Throws with `isAuthError` set when the
 * refresh token itself is dead (invalid_grant / invalid_client / 401) so the
 * caller can flag the account needs-reauth; a transient 5xx stays retry-friendly
 * (isAuthError=false).
 */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  if (!refreshToken) {
    const err: any = new Error('Google Ads: missing refresh token');
    err.isAuthError = true;
    throw err;
  }
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.accessToken;

  const form = new URLSearchParams({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET ?? '',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await safeFetch(GOOGLE_ADS_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    timeoutMs: 10_000,
  });
  const json: any = await res.json().catch(() => ({}));
  const accessToken = typeof json?.access_token === 'string' ? json.access_token : null;
  if (!res.ok || !accessToken) {
    const reason = String(json?.error ?? '');
    const err: any = new Error(
      `Google Ads token refresh ${res.status}: ${String(
        json?.error_description ?? json?.error ?? res.status,
      ).slice(0, 300)}`,
    );
    // A dead/revoked refresh token (invalid_grant), a bad app secret
    // (invalid_client), or a 401 means the operator must reconnect. Anything
    // else (5xx, network) is transient → keep it retry-friendly.
    err.isAuthError = res.status === 401 || /invalid_grant|invalid_client|unauthorized/i.test(reason);
    throw err;
  }
  const expiresIn = Number(json?.expires_in);
  const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_600_000;
  tokenCache.set(refreshToken, { accessToken, expiresAt: Date.now() + ttlMs });
  return accessToken;
}

export interface GoogleAdsError {
  httpStatus: number;
  /** gRPC status string, e.g. UNAUTHENTICATED / PERMISSION_DENIED / INVALID_ARGUMENT. */
  status: string | null;
  code: number | null;
  message: string;
  /** True when the failure is a token problem the operator must reconnect for. */
  isAuthError: boolean;
}

/**
 * Flat result (not a discriminated union) on purpose: this project sets
 * `strictNullChecks: false`, under which TS does NOT narrow `{ok:true}|{ok:false}`
 * via `if (!x.ok)`. A single interface where `data` and `error` always exist
 * (error is null iff ok) is bulletproof for every consumer. Mirrors MetaGraphResult.
 */
export interface GoogleAdsResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body — the data on success (array of searchStream batches or a
   *  mutate/upload object), or the raw error body on failure. */
  data: any;
  /** Populated only when `ok` is false; null otherwise. */
  error: GoogleAdsError | null;
}

/** Uniform write/upload result shape — mirrors MetaWriteResult exactly. */
export interface GoogleWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  isAuthError?: boolean;
}

/** True when any GoogleAdsFailure detail is an `authenticationError` (OAuth token
 *  invalid/expired) — the only detail class that means the token, not config,
 *  is at fault. `authorizationError` (dev-token/customer not enabled) is a config
 *  problem and must NOT force a token reauth. */
function hasAuthenticationErrorDetail(details: any): boolean {
  if (!Array.isArray(details)) return false;
  for (const d of details) {
    const errors = d?.errors;
    if (!Array.isArray(errors)) continue;
    for (const e of errors) {
      const ec = e?.errorCode;
      if (ec && typeof ec === 'object' && 'authenticationError' in ec) return true;
    }
  }
  return false;
}

/** Normalize a Google Ads error body + HTTP status into our uniform shape. A
 *  gRPC-REST error body is `{ error: { code, message, status, details } }`;
 *  streamed endpoints can wrap it in a one-element array. */
export function classifyGoogleError(httpStatus: number, body: any): GoogleAdsError {
  const root = (Array.isArray(body) ? body[0]?.error : body?.error) || {};
  const status = typeof root.status === 'string' ? root.status : null;
  const code = typeof root.code === 'number' ? root.code : null;
  const isAuthError =
    httpStatus === 401 ||
    status === 'UNAUTHENTICATED' ||
    hasAuthenticationErrorDetail(root.details);
  return {
    httpStatus,
    status,
    code,
    message: String(root.message ?? body?.error_description ?? `HTTP ${httpStatus}`).slice(0, 300),
    isAuthError,
  };
}

/**
 * True when an error/result represents a Google auth failure (token expired /
 * revoked / bad grant). Accepts a GoogleAdsError, a GoogleAdsResult, or any
 * thrown Error carrying an `isAuthError` flag. Mirrors isMetaAuthError.
 */
export function isGoogleAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const o = err as any;
  if (o.isAuthError === true) return true;
  if (o.ok === false && o.error && o.error.isAuthError === true) return true;
  return false;
}

export interface GoogleAdsFetchOptions {
  /** A minted access token (from refreshAccessToken) — sent as Bearer. */
  accessToken: string;
  method?: string;
  /** JSON body (object) — serialized + content-type set. */
  body?: unknown;
  /** The client customer id the path targets (digits only) — carried for logging
   *  / call-site clarity; the path already embeds it. */
  customerId?: string;
  /** The MCC the client cid is reached through. Defaults to the platform env
   *  GOOGLE_ADS_LOGIN_CUSTOMER_ID. Omitted (no header) when neither is present. */
  loginCustomerId?: string | null;
  /** Hard timeout in ms (default 20s). */
  timeoutMs?: number;
}

/** Authenticated Google Ads REST call: assembles URL + the three auth headers,
 *  transports via safeFetch, parses. */
export async function googleAdsFetch(
  path: string,
  opts: GoogleAdsFetchOptions,
): Promise<GoogleAdsResult> {
  const { accessToken, method = 'POST', body, loginCustomerId, timeoutMs = 20_000 } = opts;
  const url = `${googleAdsBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? '',
  };
  const login = normalizeCustomerId(loginCustomerId ?? process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  if (login) headers['login-customer-id'] = login;
  const init: Record<string, unknown> = { method, headers, timeoutMs };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return runGoogle(url, init);
}

async function runGoogle(url: string, init: Record<string, unknown>): Promise<GoogleAdsResult> {
  const res = await safeFetch(url, init as any);
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, status: res.status, data: json, error: classifyGoogleError(res.status, json) };
  }
  return { ok: true, status: res.status, data: json, error: null };
}
