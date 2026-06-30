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
const DEFAULT_VERSION = '202406';

export function linkedinApiVersion(): string {
  const v = process.env.LINKEDIN_API_VERSION;
  return v && /^\d{6}$/.test(v) ? v : DEFAULT_VERSION;
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

export async function linkedinRest(path: string, opts: LinkedinFetchOptions): Promise<LinkedinResult> {
  const { accessToken, method = 'GET', query, body, version, timeoutMs = 15_000 } = opts;
  const url = new URL(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'LinkedIn-Version': version ?? linkedinApiVersion(),
    'X-Restli-Protocol-Version': '2.0.0',
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
      error: { message: e?.message ?? 'network error', status: 0, serviceErrorCode: null, isAuthError: false, raw: e },
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
  const message = String(data?.message ?? `LinkedIn HTTP ${res.status}`);
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
