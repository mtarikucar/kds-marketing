import type { ErrorBody } from './types';

// The one place the panel talks HTTP. Every request is same-origin JSON with the session cookie
// (HttpOnly, never read here); every mutating request carries `X-Requested-With: jeeta-panel`,
// which the server demands before it even authenticates. Failures become `ApiError`s built
// from the structured `{ code, message, details }` body.

export const REQUESTED_WITH_HEADER = 'X-Requested-With';
export const REQUESTED_WITH_VALUE = 'jeeta-panel';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** A failed request: the server's structured error plus the HTTP status (0 when unreachable). */
export class ApiError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly status: number;

  constructor(code: string, message: string, details: Record<string, unknown>, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export interface RequestOptions {
  /** Sent as JSON. */
  body?: unknown;
  /** Appended as a query string; `undefined`, `null` and `''` values are left out. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /**
   * Whether a 401 sends the browser to the sign-in page (default `true`). Sign-in forms and
   * "am I signed in?" probes pass `false` and handle the 401 themselves.
   */
  redirectOn401?: boolean;
  signal?: AbortSignal;
}

type UnauthorizedHandler = (target: string) => void;

function defaultUnauthorized(target: string): void {
  if (window.location.pathname !== target) window.location.assign(target);
}

let onUnauthorized: UnauthorizedHandler = defaultUnauthorized;

/** Replaces what a 401 does (the app routes it through the router; tests record it). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

/** Where a 401 on `path` sends the browser: the platform console has its own sign-in. */
export function loginPathFor(path: string): string {
  return path === '/api/platform' || path.startsWith('/api/platform/') ? '/platform/login' : '/login';
}

const MUTATING: ReadonlySet<Method> = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string';
}

async function errorFrom(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (isErrorBody(body)) {
    const details =
      body.details !== null && typeof body.details === 'object'
        ? (body.details as Record<string, unknown>)
        : {};
    return new ApiError(body.code, body.message, details, res.status);
  }
  const code = res.status === 401 ? 'UNAUTHENTICATED' : res.status === 404 ? 'NOT_FOUND' : 'INTERNAL';
  return new ApiError(code, res.statusText || `HTTP ${res.status}`, {}, res.status);
}

/** Sends one request to the server and returns its JSON body (`undefined` for an empty one). */
export async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (MUTATING.has(method)) headers[REQUESTED_WITH_HEADER] = REQUESTED_WITH_VALUE;
  const init: RequestInit = { method, headers, credentials: 'same-origin', signal: options.signal };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(withQuery(path, options.query), init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('NETWORK', err instanceof Error ? err.message : 'network error', {}, 0);
  }

  if (!res.ok) {
    const error = await errorFrom(res);
    if (res.status === 401 && options.redirectOn401 !== false) onUnauthorized(loginPathFor(path));
    throw error;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A path segment, escaped. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
