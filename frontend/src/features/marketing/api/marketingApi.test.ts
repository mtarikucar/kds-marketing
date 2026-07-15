import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import marketingApi, { isNoRefreshPath, NO_REFRESH_PATHS } from './marketingApi';
import { useMarketingAuthStore, type MarketingUser } from '../../../store/marketingAuthStore';

/**
 * Guards the root-cause fix: the response interceptor must NOT run its
 * refresh-and-retry path for unauthenticated auth endpoints. Without this, a
 * 401 from /auth/login triggers a refresh that fails with 'no refresh token'
 * (when logged out), masking the real "wrong credentials" error.
 */
describe('isNoRefreshPath', () => {
  it('returns true for every unauthenticated auth endpoint', () => {
    for (const path of NO_REFRESH_PATHS) {
      expect(isNoRefreshPath(path)).toBe(true);
    }
  });

  it('matches the login endpoint (the reported "no refresh token" case)', () => {
    expect(isNoRefreshPath('/auth/login')).toBe(true);
    // baseURL-prefixed / absolute forms still match via substring.
    expect(isNoRefreshPath('http://api.example.com/marketing/auth/login')).toBe(true);
  });

  it('returns false for normal authenticated endpoints (refresh-retry still applies)', () => {
    expect(isNoRefreshPath('/leads')).toBe(false);
    expect(isNoRefreshPath('/dashboard/summary')).toBe(false);
    expect(isNoRefreshPath('/auth/logout')).toBe(false);
    expect(isNoRefreshPath('/auth/change-password')).toBe(false);
  });

  it('returns false for nullish urls', () => {
    expect(isNoRefreshPath(undefined)).toBe(false);
    expect(isNoRefreshPath(null)).toBe(false);
    expect(isNoRefreshPath('')).toBe(false);
  });
});

const baseUser: MarketingUser = {
  id: 'u1',
  workspaceId: 'ws1',
  email: 'a@b.com',
  firstName: 'A',
  lastName: 'B',
  role: 'OWNER',
};

const initialAuthState = useMarketingAuthStore.getState();

/**
 * Grabs the response interceptor's `rejected` handler that marketingApi.ts
 * registers via `marketingApi.interceptors.response.use(...)`. Axios doesn't
 * expose a public API to invoke a registered interceptor directly, but
 * `InterceptorManager` (a stable, long-standing internal) stores each
 * registration in `.handlers` in order — index 0 is the only response
 * interceptor this module adds. Reaching in here lets the test drive the
 * REAL registered logic (not a reimplementation of it) without a mock HTTP
 * adapter, which this project doesn't otherwise depend on.
 */
function getResponseRejectedHandler() {
  const handlers = (
    marketingApi.interceptors.response as unknown as {
      handlers: Array<{ rejected: (error: unknown) => Promise<unknown> } | null>;
    }
  ).handlers;
  const handler = handlers[0];
  if (!handler) throw new Error('marketingApi response interceptor not registered');
  return handler.rejected;
}

function make401(url: string): { config: InternalAxiosRequestConfig; response: { status: number } } {
  return {
    config: { url, headers: {} } as InternalAxiosRequestConfig,
    response: { status: 401 },
  };
}

/**
 * Orphaned-session handling (multi-workspace membership): a user whose only
 * membership is suspended/removed mid-session keeps a live-looking access
 * token, but the NEXT request 401s. The response interceptor's normal move
 * is "refresh and retry" — but the backend's /auth/refresh path re-resolves
 * the active membership too (MarketingAuthService.refreshToken ->
 * getActiveMembership), finds none, and ALSO 401s ("Session revoked"). This
 * proves that double-401 collapses into a clean logout rather than an
 * infinite retry loop or a stuck, silently-broken session.
 */
describe('marketingApi response interceptor — orphaned session (refresh also fails)', () => {
  beforeEach(() => {
    useMarketingAuthStore.setState(
      {
        ...initialAuthState,
        user: baseUser,
        accessToken: 'stale-access-token',
        refreshToken: 'stale-refresh-token',
        isAuthenticated: true,
        agencyReturn: null,
        memberships: [{ workspaceId: 'ws1', workspaceName: 'WS One', role: 'OWNER' }],
      },
      true,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useMarketingAuthStore.setState(initialAuthState, true);
  });

  it('logs the user out (clears the store) when the refresh call itself 401s', async () => {
    // Backend: MarketingAuthService.refreshToken() -> getActiveMembership()
    // returns null (sole membership suspended/removed) -> 401 'Session revoked'.
    const refreshRejection = {
      isAxiosError: true,
      response: { status: 401, data: { message: 'Session revoked' } },
      config: { url: '/marketing/auth/refresh', headers: {} },
    };
    vi.spyOn(axios, 'post').mockRejectedValue(refreshRejection);

    const rejected = getResponseRejectedHandler();
    const original401 = make401('/leads');

    await expect(rejected(original401)).rejects.toBe(refreshRejection);

    const state = useMarketingAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.accessToken).toBeNull();
    expect(state.refreshToken).toBeNull();
    expect(state.user).toBeNull();
  });

  it('logs the user out when there is no refresh token to even attempt (already-orphaned store)', async () => {
    useMarketingAuthStore.setState({ refreshToken: null });
    const postSpy = vi.spyOn(axios, 'post');

    const rejected = getResponseRejectedHandler();
    const original401 = make401('/leads');

    await expect(rejected(original401)).rejects.toThrow('no refresh token');

    // No network call was even attempted — refreshMarketingToken() short-circuits.
    expect(postSpy).not.toHaveBeenCalled();

    const state = useMarketingAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.accessToken).toBeNull();
  });

  it('does NOT log out for a 401 on a no-refresh path (e.g. switch-workspace rejecting THIS user)', async () => {
    const postSpy = vi.spyOn(axios, 'post');
    const rejected = getResponseRejectedHandler();
    const original401 = make401('/marketing/auth/switch-workspace');

    await expect(rejected(original401)).rejects.toBe(original401);

    // isNoRefreshPath short-circuits before any refresh attempt or logout —
    // this 401 is about the target workspace, not a dead session.
    expect(postSpy).not.toHaveBeenCalled();
    expect(useMarketingAuthStore.getState().isAuthenticated).toBe(true);
  });
});
