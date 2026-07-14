import axios from 'axios';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { API_URL } from '../../../lib/env';

const marketingApi = axios.create({
  baseURL: `${API_URL}/marketing`,
  headers: { 'Content-Type': 'application/json' },
});

// Single-flight refresh — mirrors lib/api.ts. The previous version fired
// N concurrent /marketing/auth/refresh calls on N parallel 401s, which
// raced against the backend's refresh-token rotation (each rotation
// revokes the previous token) and forced random logouts.
const REFRESH_TIMEOUT_MS = 10_000;
let refreshInFlight: Promise<string> | null = null;
// The refresh token the in-flight refresh is rotating. A session swap — login,
// logout+login, enterLocation (impersonate a sub-account) or returnToAgency —
// changes the store's refreshToken, so a refresh STARTED under the old session
// must not be reused by, or written back into, the NEW one. Without this key an
// in-flight LOCATION refresh could hand a LOCATION access token to the first
// agency request after "Return to agency" (403s / stranded impersonation), or a
// refresh resolving after logout() could re-persist a live refresh token
// (zombie session in sessionStorage).
let refreshForToken: string | null = null;

export function refreshMarketingToken(): Promise<string> {
  const startingRefresh = useMarketingAuthStore.getState().refreshToken;
  if (!startingRefresh) {
    return Promise.reject(new Error('no refresh token'));
  }
  // Reuse the in-flight refresh ONLY when it belongs to the CURRENT session's
  // refresh token — same-session concurrent 401s still share one refresh
  // (single-flight), but a post-swap caller starts its own.
  if (refreshInFlight && refreshForToken === startingRefresh) return refreshInFlight;

  refreshForToken = startingRefresh;
  const refresh = axios
    .post(
      `${API_URL}/marketing/auth/refresh`,
      { refreshToken: startingRefresh },
      { timeout: REFRESH_TIMEOUT_MS },
    )
    .then((response) => {
      const { accessToken, refreshToken } = response.data;
      // Backend rotates the refresh token on every call. Persist both halves so
      // the next round uses the fresh one — BUT only if the session hasn't
      // swapped out from under us while the refresh was in flight, else we'd
      // clobber the new session's tokens (or revive a logged-out session).
      if (useMarketingAuthStore.getState().refreshToken === startingRefresh) {
        useMarketingAuthStore.getState().setTokens(
          accessToken,
          refreshToken ?? startingRefresh,
        );
      }
      return accessToken as string;
    });
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(
      () => reject(new Error('marketing refresh timeout')),
      REFRESH_TIMEOUT_MS,
    ),
  );
  const inFlight = Promise.race([refresh, timeout]).finally(() => {
    // Clear only if this is STILL the current in-flight — a session swap may
    // have already replaced it with a newer refresh for a different session.
    if (refreshInFlight === inFlight) {
      refreshInFlight = null;
      refreshForToken = null;
    }
  });
  refreshInFlight = inFlight;
  return inFlight;
}

marketingApi.interceptors.request.use(async (config) => {
  let { accessToken } = useMarketingAuthStore.getState();
  const { refreshToken } = useMarketingAuthStore.getState();
  // The access token lives in memory only (never persisted), so every full
  // page load / F5 / deep link starts with it null while the refresh token
  // survives in sessionStorage. Without this, the first wave of queries fired
  // on mount went out with no Authorization header → "No token provided" 401s
  // (recovered by the response interceptor, but noisy + a wasted round-trip).
  // Proactively run the single-flight refresh here so those first requests
  // carry a fresh token. Single-flight means N parallel mount requests share
  // ONE refresh.
  if (!accessToken && refreshToken) {
    try {
      accessToken = await refreshMarketingToken();
    } catch {
      // Refresh failed (e.g. revoked/expired refresh token) — let the request
      // proceed unauthenticated; the response interceptor handles the logout.
    }
  }
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// Unauthenticated auth endpoints. A 401 from these means "bad credentials /
// bad or expired token" — NOT "access token expired mid-session". Running the
// refresh-retry path here is wrong: when logged out there is no refresh token,
// so refreshMarketingToken() rejects with 'no refresh token', and the response
// interceptor then surfaces THAT error instead of the real 401. The login page
// would show "no refresh token" instead of "wrong credentials". So these paths
// must bypass refresh entirely and let the original 401 propagate.
export const NO_REFRESH_PATHS = [
  '/auth/login',
  '/auth/register-workspace',
  '/auth/2fa/verify',
  '/auth/refresh',
] as const;

export function isNoRefreshPath(url: string | undefined | null): boolean {
  if (!url) return false;
  return NO_REFRESH_PATHS.some((path) => url.includes(path));
}

marketingApi.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (
      error.response?.status === 401 &&
      !originalRequest?._retry &&
      !isNoRefreshPath(originalRequest?.url)
    ) {
      originalRequest._retry = true;
      try {
        const accessToken = await refreshMarketingToken();
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return marketingApi(originalRequest);
      } catch (refreshError) {
        useMarketingAuthStore.getState().logout();
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  },
);

export default marketingApi;
