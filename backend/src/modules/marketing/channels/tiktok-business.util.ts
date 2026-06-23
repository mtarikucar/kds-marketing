// backend/src/modules/marketing/channels/tiktok-business.util.ts
import { safeFetch } from '../../../common/util/safe-fetch';

/**
 * Thin client for the TikTok-for-Business API (business-api.tiktok.com).
 * Plain module (NOT a Nest provider) so tests can mock `safeFetch` at the
 * module seam — mirrors how the Meta Graph helper is structured.
 *
 * Response envelope is { code, message, request_id, data }; code === 0 is
 * success even on HTTP 200-with-error-code. Auth/permission failures surface
 * as specific non-zero codes (or HTTP 401) and must be classified so the ads
 * sweep / DM send can flag reauth_required rather than retry forever.
 */
const DEFAULT_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

export function businessApiBaseUrl(): string {
  const override = process.env.TIKTOK_BUSINESS_API_BASE_URL;
  return (override && override.replace(/\/+$/, '')) || DEFAULT_BASE;
}

export interface TiktokBusinessRequest {
  accessToken: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export class TiktokBusinessError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: number,
    readonly requestId: string | undefined,
    readonly isAuthError: boolean,
  ) {
    super(message);
    this.name = 'TiktokBusinessError';
  }
}

export type TiktokBusinessResult<T = any> =
  | { ok: true; data: T; requestId?: string; error: null }
  | { ok: false; error: TiktokBusinessError };

/** Auth/permission/token codes per the TikTok Business API error reference. */
const AUTH_CODES = new Set([40001, 40002, 40100, 40101, 40102, 40104, 40105, 40110]);

export function isTiktokBusinessAuthError(err: unknown): boolean {
  return err instanceof TiktokBusinessError && err.isAuthError;
}

export async function tiktokBusinessFetch<T = any>(
  path: string,
  req: TiktokBusinessRequest,
): Promise<TiktokBusinessResult<T>> {
  const { accessToken, method = 'GET', query, body, timeoutMs = 20_000 } = req;

  const url = new URL(`${businessApiBaseUrl()}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  let res: Response;
  try {
    res = await safeFetch(url.toString(), {
      method,
      headers: {
        'Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs,
    });
  } catch (e: any) {
    // Network/SSRF/timeout — not an auth verdict; let the caller retry later.
    return {
      ok: false,
      error: new TiktokBusinessError(e?.message ?? 'network error', 0, 0, undefined, false),
    };
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    json = {};
  }

  const code = Number(json?.code ?? (res.ok ? 0 : -1));
  const requestId = typeof json?.request_id === 'string' ? json.request_id : undefined;

  if (res.ok && code === 0) {
    return { ok: true, data: json?.data as T, requestId, error: null };
  }

  const isAuth = res.status === 401 || AUTH_CODES.has(code);
  const message = String(json?.message ?? `HTTP ${res.status}`);
  return {
    ok: false,
    error: new TiktokBusinessError(message, res.status, code, requestId, isAuth),
  };
}
