import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock axios so module-load `axios.create()` (the marketingApi instance +
// interceptor registration) and the refresh path's `axios.post` are both
// controllable. The instance's interceptors are no-ops here.
vi.mock('axios', () => {
  const post = vi.fn();
  const instance = Object.assign(vi.fn(), {
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  });
  const axiosMock = { create: vi.fn(() => instance), post };
  return { default: axiosMock, ...axiosMock };
});

import axios from 'axios';
import { isNoRefreshPath, NO_REFRESH_PATHS, refreshMarketingToken } from './marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

const post = axios.post as unknown as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

/**
 * Guards the session-aware single-flight refresh. A refresh started under one
 * session must never leak its rotated tokens into — or be reused by — a
 * DIFFERENT session created mid-flight (agency impersonation swap / logout /
 * re-login). Otherwise the operator is stranded in a wrong-session or a live
 * refresh token survives a logout.
 */
describe('refreshMarketingToken — session-aware single-flight', () => {
  beforeEach(() => {
    post.mockReset();
    useMarketingAuthStore.setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      agencyReturn: null,
    });
  });

  it('does NOT write rotated tokens back if the session swapped while the refresh was in flight', async () => {
    useMarketingAuthStore.setState({ refreshToken: 'A' });
    const d = deferred<{ data: { accessToken: string; refreshToken: string } }>();
    post.mockReturnValueOnce(d.promise);

    const p = refreshMarketingToken(); // starts refresh for session 'A'
    // Session swaps to 'B' mid-flight (e.g. returnToAgency clears accessToken +
    // installs the agency refresh token).
    useMarketingAuthStore.setState({ refreshToken: 'B', accessToken: null });

    d.resolve({ data: { accessToken: 'newA', refreshToken: 'rotA' } });
    await p;

    // The new session's tokens are untouched — no clobber to 'rotA'.
    expect(useMarketingAuthStore.getState().refreshToken).toBe('B');
    expect(useMarketingAuthStore.getState().accessToken).toBeNull();
  });

  it('writes the rotated pair back when the session is unchanged', async () => {
    useMarketingAuthStore.setState({ refreshToken: 'A' });
    post.mockResolvedValueOnce({ data: { accessToken: 'newA', refreshToken: 'rotA' } });

    const token = await refreshMarketingToken();

    expect(token).toBe('newA');
    expect(useMarketingAuthStore.getState().accessToken).toBe('newA');
    expect(useMarketingAuthStore.getState().refreshToken).toBe('rotA');
  });

  it('starts a FRESH refresh for the new session instead of handing over the old in-flight one', async () => {
    useMarketingAuthStore.setState({ refreshToken: 'A' });
    const dA = deferred<{ data: { accessToken: string; refreshToken: string } }>();
    post.mockReturnValueOnce(dA.promise);
    const pA = refreshMarketingToken();

    useMarketingAuthStore.setState({ refreshToken: 'B', accessToken: null });
    const dB = deferred<{ data: { accessToken: string; refreshToken: string } }>();
    post.mockReturnValueOnce(dB.promise);
    const pB = refreshMarketingToken();

    // Two DISTINCT posts; the second is for the NEW session's token.
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toEqual({ refreshToken: 'B' });

    dA.resolve({ data: { accessToken: 'newA', refreshToken: 'rotA' } });
    dB.resolve({ data: { accessToken: 'newB', refreshToken: 'rotB' } });
    const [ta, tb] = await Promise.all([pA, pB]);

    expect(ta).toBe('newA');
    expect(tb).toBe('newB');
    // Only session B's rotation was written back.
    expect(useMarketingAuthStore.getState().refreshToken).toBe('rotB');
  });

  it('same-session concurrent 401s share ONE refresh (single-flight preserved)', async () => {
    useMarketingAuthStore.setState({ refreshToken: 'A' });
    const dA = deferred<{ data: { accessToken: string; refreshToken: string } }>();
    post.mockReturnValueOnce(dA.promise);

    const p1 = refreshMarketingToken();
    const p2 = refreshMarketingToken();

    expect(p1).toBe(p2); // same in-flight promise reused
    expect(post).toHaveBeenCalledTimes(1);

    dA.resolve({ data: { accessToken: 'newA', refreshToken: 'rotA' } });
    await Promise.all([p1, p2]);
  });

  it('rejects with no network call when there is no refresh token (logged out)', async () => {
    useMarketingAuthStore.setState({ refreshToken: null });

    await expect(refreshMarketingToken()).rejects.toThrow('no refresh token');
    expect(post).not.toHaveBeenCalled();
  });
});
