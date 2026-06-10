/**
 * Single source of truth for environment-driven URLs.
 *
 * We used to sprinkle `import.meta.env.VITE_API_URL || 'http://localhost:3000/api'`
 * across 30+ files. If the env var wasn't injected at build time (GitHub
 * Actions ARG missing, docker-compose typo) the app would silently point
 * at localhost in production and 404 every request — the error only
 * surfaces as CORS / connection refused in the browser console.
 *
 * By centralizing and surfacing a warning, a missing env var is visible
 * once at module load rather than hidden behind dozens of call sites.
 */

// Vite's `import.meta.env.MODE` is 'development' when running `vite` and
// 'production' for `vite build`. Treating them the same keeps local dev
// working with the sensible fallback, while production builds that lost
// their env vars get a visible console.error.
const DEV_FALLBACK_ORIGIN = 'http://localhost:3000';

function resolveApiUrl(): string {
  const fromEnv = import.meta.env.VITE_API_URL;
  if (fromEnv) return fromEnv;

  if (import.meta.env.PROD) {
    // v3.0.1 round-3 — hard-fail instead of console.error + silent
    // localhost fallback. Pre-fix a production build that lost its
    // env var pointed every request at localhost:3000 and surfaced
    // as a CORS failure in the browser console; ops had no signal
    // because a console.error inside a customer's browser is
    // invisible to them. Throwing on module load makes the bundle
    // crash on first import, which surfaces immediately in:
    //   - the GitHub Actions step that smoke-checks the built bundle,
    //   - any uptime probe that hits the SPA root,
    //   - the developer running `vite preview` over a prod build.
    // Dev mode (`vite`, MODE === 'development') still falls through
    // to the localhost default so devs without an env file work out
    // of the box.
    throw new Error(
      '[env] VITE_API_URL is not set in production build. Check the ' +
        'Dockerfile ARG/ENV wiring and the docker-compose build args ' +
        'for the marketing-spa service. Refusing to start with a ' +
        'silently-wrong API base URL.',
    );
  }
  return `${DEV_FALLBACK_ORIGIN}/api`;
}

function resolveAssetsOrigin(): string {
  // Asset URLs (product images, uploaded files) need the backend origin
  // without the `/api` suffix. Prefer an explicit VITE_API_BASE_URL, but
  // derive from VITE_API_URL by stripping a trailing `/api` if missing.
  const explicit = (import.meta.env as Record<string, string | undefined>)
    .VITE_API_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');

  const apiUrl = resolveApiUrl();
  return apiUrl.replace(/\/api\/?$/, '').replace(/\/+$/, '');
}

export const API_URL = resolveApiUrl();
export const ASSETS_ORIGIN = resolveAssetsOrigin();

/**
 * Resolve a possibly-relative asset URL (e.g. `/uploads/products/foo.jpg`)
 * against the backend origin. Absolute URLs (`http://...`, `https://...`,
 * `data:`, `blob:`) pass through unchanged.
 */
export function assetUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  const cleaned = path.startsWith('/') ? path : `/${path}`;
  return `${ASSETS_ORIGIN}${cleaned}`;
}
