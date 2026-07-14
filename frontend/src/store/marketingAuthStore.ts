import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface MarketingUser {
  id: string;
  workspaceId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'OWNER' | 'MANAGER' | 'REP';
  phone?: string;
  avatar?: string;
}

/** The agency session stashed while an OWNER is switched INTO a sub-account, so
 *  "return to agency" can restore it. Only the (rotating) refresh half + display
 *  user are kept — the access token is minted on demand by the api client. */
export interface AgencyReturn {
  user: MarketingUser;
  refreshToken: string;
  locationName: string;
}

interface MarketingAuthState {
  user: MarketingUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  /** Set only while impersonating a sub-account; drives the "return to agency" banner. */
  agencyReturn: AgencyReturn | null;

  login: (user: MarketingUser, accessToken: string, refreshToken: string) => void;
  /** Enter a child LOCATION: stash the current agency session, then swap to the
   *  location's tokens. No-op re-nesting (already impersonating keeps the ORIGINAL
   *  agency return, so switching between two locations still returns to the agency). */
  enterLocation: (
    user: MarketingUser,
    accessToken: string,
    refreshToken: string,
    locationName: string,
  ) => void;
  /** Restore the stashed agency session (access token null → refreshed on demand). */
  returnToAgency: () => void;
  setAccessToken: (accessToken: string) => void;
  // Backend rotates both halves of the pair on every /auth/refresh — if we
  // only stored the access half, the next refresh would present a stale
  // refresh token and bounce to login.
  setTokens: (accessToken: string, refreshToken: string) => void;
  // Merges a partial patch into the current user (e.g. after PATCH
  // /marketing/auth/profile) so the header greeting and anywhere else reading
  // `user` reflect the edit immediately, without a full re-login.
  updateUser: (patch: Partial<MarketingUser>) => void;
  logout: () => void;
}

export const useMarketingAuthStore = create<MarketingAuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      agencyReturn: null,

      login: (user: MarketingUser, accessToken: string, refreshToken: string) => {
        // A fresh login clears any stale impersonation stash.
        set({
          user,
          accessToken,
          refreshToken,
          isAuthenticated: true,
          agencyReturn: null,
        });
      },

      enterLocation: (user, accessToken, refreshToken, locationName) => {
        set((state) => ({
          // Keep the ORIGINAL agency return if already impersonating (location→location
          // hop still returns to the agency, not the previous location).
          agencyReturn:
            state.agencyReturn ??
            (state.user && state.refreshToken
              ? { user: state.user, refreshToken: state.refreshToken, locationName }
              : null),
          user,
          accessToken,
          refreshToken,
          isAuthenticated: true,
        }));
      },

      returnToAgency: () => {
        set((state) =>
          state.agencyReturn
            ? {
                user: state.agencyReturn.user,
                refreshToken: state.agencyReturn.refreshToken,
                accessToken: null, // api client's single-flight refresh mints a fresh one
                isAuthenticated: true,
                agencyReturn: null,
              }
            : state,
        );
      },

      setAccessToken: (accessToken: string) => {
        set({ accessToken });
      },

      setTokens: (accessToken: string, refreshToken: string) => {
        set({ accessToken, refreshToken });
      },

      updateUser: (patch: Partial<MarketingUser>) => {
        set((state) => (state.user ? { user: { ...state.user, ...patch } } : state));
      },

      logout: () => {
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
          agencyReturn: null,
        });
      },
    }),
    {
      name: 'marketing-auth-storage',
      // Per-tab isolation: sessionStorage instead of the default localStorage,
      // so each browser tab has its OWN independent session. Logging out or
      // switching user in one tab no longer changes who you are in the others
      // (localStorage is shared across all tabs of an origin — that shared
      // store was the cross-tab bleed). Survives same-tab reload (F5); a
      // brand-new tab starts logged out and must sign in.
      storage: createJSONStorage(() => sessionStorage),
      // The ACCESS token stays in memory only, but the REFRESH token must
      // be persisted: every full page load (deep link, F5) starts with an
      // empty store, and the api client's single-flight refresh is the only
      // way back to a session. The previous stance persisted neither —
      // which silently logged every user out on reload (all requests 401 →
      // interceptor logout). Rotation caps the blast radius of a stolen
      // refresh token: each use revokes it server-side.
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        refreshToken: state.refreshToken,
        // Persist the impersonation stash so an F5 inside a sub-account still
        // offers "return to agency" (and doesn't strand the operator).
        agencyReturn: state.agencyReturn,
      }),
    }
  )
);
