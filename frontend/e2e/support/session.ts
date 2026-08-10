/**
 * Putting an authenticated session into the browser.
 *
 * WHY NOT `storageState`: Playwright's storageState serialises cookies and
 * localStorage only. This app persists its auth store in **sessionStorage**
 * (`marketingAuthStore.ts:249`, `createJSONStorage(() => sessionStorage)`) for
 * per-tab isolation, so the textbook recipe silently yields a logged-OUT
 * browser that bounces to /login. Injecting before any app code runs is the
 * only path that works.
 *
 * WHY ONLY THE REFRESH TOKEN: the store deliberately keeps `accessToken` in
 * memory and persists only `user`, `isAuthenticated`, `refreshToken`,
 * `agencyReturn` and `memberships` (`marketingAuthStore.ts:257-268`). The api
 * client's interceptor mints a fresh access token on the first request, so a
 * seeded refresh token is sufficient — verified against a live backend.
 *
 * KEEP THIS SHAPE IN SYNC with the `partialize` block in
 * `src/store/marketingAuthStore.ts`. If a field is added there, add it here.
 */
import type { Page } from '@playwright/test';
import { AUTH_STORAGE_KEY } from './config';
import type { AuthSession } from './api';

/** The exact persisted shape zustand writes for `marketing-auth-storage`. */
export function persistedAuthState(session: AuthSession): string {
  return JSON.stringify({
    state: {
      user: session.user,
      isAuthenticated: true,
      refreshToken: session.refreshToken,
      agencyReturn: null,
      memberships: [],
    },
    version: 0,
  });
}

/**
 * Seed the session so the very first navigation lands authenticated.
 * Must be called BEFORE `page.goto` — addInitScript runs on every document
 * before any page script, which is what makes a deep link work on first hit.
 */
export async function seedSession(page: Page, session: AuthSession): Promise<void> {
  await page.addInitScript(
    ([key, value]) => window.sessionStorage.setItem(key as string, value as string),
    [AUTH_STORAGE_KEY, persistedAuthState(session)] as const,
  );
}
