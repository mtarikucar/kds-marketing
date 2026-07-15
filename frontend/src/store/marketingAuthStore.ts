import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** Summary of one workspace a user belongs to, as returned by
 *  GET /marketing/auth/profile's `memberships` array. Mirrors
 *  features/marketing/api/membershipApi.ts's identically-named interface —
 *  re-exported here so store consumers don't need to reach into the api
 *  module just for the type. */
export interface MembershipSummary {
  workspaceId: string;
  workspaceName: string;
  role: string;
}

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
  /** The full list of workspaces this user belongs to (multi-workspace
   *  membership). Sourced from GET /marketing/auth/profile — neither /auth/login
   *  nor /auth/switch-workspace return it on their own response. */
  memberships: MembershipSummary[];

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
  /** Replaces the membership list wholesale (e.g. after fetchMemberships()). */
  setMemberships: (memberships: MembershipSummary[]) => void;
  /** Switches the ACTIVE workspace for a user who belongs to more than one —
   *  distinct from `enterLocation`'s agency-impersonation flow: no
   *  `agencyReturn` stash is touched, because this is the user's OWN session
   *  moving between their OWN workspaces, not an agency operator borrowing a
   *  sub-account's identity. */
  switchWorkspace: (workspaceId: string) => Promise<void>;
  /** Self-serve "second brand" flow: creates a brand-new STANDALONE workspace
   *  owned by the CURRENT identity and auto-switches the session into it —
   *  mirrors `switchWorkspace`'s token-swap (same `agencyReturn`-untouched
   *  posture), except there is no pre-existing target membership to select
   *  FROM, since the workspace didn't exist until this call created it.
   *  Resolves with the new workspace's `{ id, name, slug }` summary so the
   *  caller (the profile-menu "New workspace" dialog) can toast/navigate. */
  createWorkspace: (dto: {
    workspaceName: string;
    productName?: string;
    productUrl?: string;
    productDescription?: string;
    language?: string;
    currency?: string;
  }) => Promise<{ id: string; name: string; slug: string }>;
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
      memberships: [],

      login: (user: MarketingUser, accessToken: string, refreshToken: string) => {
        // A fresh login clears any stale impersonation stash and any
        // membership list left over from a previous session — the caller
        // (MarketingLoginPage) follows up with fetchMemberships() +
        // setMemberships() once the profile call resolves.
        set({
          user,
          accessToken,
          refreshToken,
          isAuthenticated: true,
          agencyReturn: null,
          memberships: [],
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

      setMemberships: (memberships: MembershipSummary[]) => {
        set({ memberships });
      },

      switchWorkspace: async (workspaceId: string) => {
        // Dynamic import (not a static top-level one): membershipApi.ts
        // imports marketingApi.ts, which imports THIS store — a static
        // top-level import here would be a circular import cycle. Resolving
        // it lazily at call time, after both modules have finished loading,
        // sidesteps that.
        const { switchWorkspaceApi, fetchMemberships } = await import(
          '../features/marketing/api/membershipApi'
        );
        const data = await switchWorkspaceApi(workspaceId);
        set((state) => ({
          user: state.user
            ? { ...state.user, workspaceId: data.user.workspaceId, role: data.user.role }
            : data.user,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          // NOTE: agencyReturn is intentionally left untouched here — a
          // workspace switch is NOT impersonation, so there is no agency
          // session to stash and no "return to agency" banner to arm.
        }));
        // Best-effort: the token swap above has already committed, so a
        // hiccup fetching the refreshed membership list (network blip, a
        // stale profile response, etc.) must NOT fail the switch itself —
        // callers (the top-bar WorkspaceSwitcher) await this action before
        // clearing the query cache and navigating, and the switch already
        // succeeded server-side. Worst case the membership list is stale
        // until the next profile fetch.
        try {
          const memberships = await fetchMemberships();
          set({ memberships });
        } catch (err) {
          console.warn('switchWorkspace: failed to refresh memberships after switch', err);
        }
      },

      createWorkspace: async (dto) => {
        // Same dynamic-import rationale as switchWorkspace above — sidesteps
        // the membershipApi -> marketingApi -> this store circular-import cycle.
        const { createWorkspaceApi, fetchMemberships } = await import(
          '../features/marketing/api/membershipApi'
        );
        const data = await createWorkspaceApi(dto);
        set((state) => ({
          user: state.user
            ? { ...state.user, workspaceId: data.user.workspaceId, role: data.user.role }
            : data.user,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          // NOTE: agencyReturn is intentionally left untouched — same
          // rationale as switchWorkspace: this is the user's OWN session
          // moving into a workspace they just created for themselves, not
          // agency impersonation.
        }));
        // Best-effort, same posture as switchWorkspace: the token swap above
        // has already committed and the workspace already exists
        // server-side, so a hiccup refreshing the membership list must not
        // fail the create itself.
        try {
          const memberships = await fetchMemberships();
          set({ memberships });
        } catch (err) {
          console.warn('createWorkspace: failed to refresh memberships after create', err);
        }
        return data.workspace;
      },

      logout: () => {
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
          agencyReturn: null,
          memberships: [],
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
        // Persist the membership list too — otherwise a page reload (F5)
        // shows an empty workspace switcher until the next profile fetch.
        memberships: state.memberships,
      }),
    }
  )
);
