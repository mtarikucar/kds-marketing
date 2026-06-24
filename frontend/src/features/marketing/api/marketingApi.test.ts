import { describe, it, expect } from 'vitest';
import { isNoRefreshPath, NO_REFRESH_PATHS } from './marketingApi';

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
