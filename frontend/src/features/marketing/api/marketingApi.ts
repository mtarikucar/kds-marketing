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

function refreshMarketingToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  const store = useMarketingAuthStore.getState();
  if (!store.refreshToken) {
    return Promise.reject(new Error('no refresh token'));
  }
  const refresh = axios
    .post(
      `${API_URL}/marketing/auth/refresh`,
      { refreshToken: store.refreshToken },
      { timeout: REFRESH_TIMEOUT_MS },
    )
    .then((response) => {
      const { accessToken, refreshToken } = response.data;
      // Backend rotates the refresh token on every call. Persist both
      // halves so the next refresh round uses the fresh one — otherwise
      // we'd present a stale (revoked) refresh and immediately log out.
      useMarketingAuthStore.getState().setTokens(
        accessToken,
        refreshToken ?? store.refreshToken,
      );
      return accessToken as string;
    });
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(
      () => reject(new Error('marketing refresh timeout')),
      REFRESH_TIMEOUT_MS,
    ),
  );
  refreshInFlight = Promise.race([refresh, timeout]).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
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

marketingApi.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
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
