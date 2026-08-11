/**
 * E2E environment wiring — one place that knows where the stack lives.
 *
 * The suite talks to a REAL backend against a DEDICATED database
 * (`marketing_e2e`), never the dev database: main's migration history and the
 * local dev DB have diverged, and E2E must be free to create/destroy data.
 * See ops/e2e/README.md for how to bring the stack up.
 */

/** Vite origin under test. */
export const APP_URL = process.env.E2E_APP_URL ?? 'http://localhost:5173';

/** Backend origin INCLUDING the global /api prefix, no trailing slash. */
export const API_URL = (process.env.E2E_API_URL ?? 'http://localhost:3101/api').replace(/\/+$/, '');

/**
 * Build an absolute API URL.
 *
 * Deliberately explicit rather than leaning on Playwright's `baseURL`: that
 * joins with `new URL(path, baseURL)` semantics, so a leading-slash path
 * REPLACES the base path — `new URL('/health', '…:3101/api')` silently becomes
 * `…:3101/health` and every call 404s with no hint as to why.
 */
export function apiUrl(path: string): string {
  return `${API_URL}/${path.replace(/^\/+/, '')}`;
}

/**
 * sessionStorage key written by the zustand persist middleware in
 * `src/store/marketingAuthStore.ts` (`name: 'marketing-auth-storage'`).
 */
export const AUTH_STORAGE_KEY = 'marketing-auth-storage';

/**
 * Where globalSetup stashes the single registered owner. One registration per
 * RUN, not per test: the register route is throttled at 3/60s with a TEN
 * MINUTE block (marketing-auth.controller.ts:37) — measured as 201,429,429,429.
 */
export const OWNER_STATE_FILE = 'e2e/.auth/owner.json';

/** Password used for the E2E owner. Must satisfy: >=8 chars, a letter and a digit. */
export const OWNER_PASSWORD = 'E2eOwner2026';
