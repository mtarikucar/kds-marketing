import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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

interface MarketingAuthState {
  user: MarketingUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;

  login: (user: MarketingUser, accessToken: string, refreshToken: string) => void;
  setAccessToken: (accessToken: string) => void;
  // Backend rotates both halves of the pair on every /auth/refresh — if we
  // only stored the access half, the next refresh would present a stale
  // refresh token and bounce to login.
  setTokens: (accessToken: string, refreshToken: string) => void;
  logout: () => void;
}

export const useMarketingAuthStore = create<MarketingAuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,

      login: (user: MarketingUser, accessToken: string, refreshToken: string) => {
        set({
          user,
          accessToken,
          refreshToken,
          isAuthenticated: true,
        });
      },

      setAccessToken: (accessToken: string) => {
        set({ accessToken });
      },

      setTokens: (accessToken: string, refreshToken: string) => {
        set({ accessToken, refreshToken });
      },

      logout: () => {
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
        });
      },
    }),
    {
      name: 'marketing-auth-storage',
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
      }),
    }
  )
);
