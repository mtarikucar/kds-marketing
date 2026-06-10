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
      // Tokens (both access AND refresh) stay in memory only — persisting
      // either makes XSS a session-takeover primitive for a long-term
      // (30-day) stolen refresh. Matches the SuperAdmin store's stance.
      // On reload we rely on the persisted `user` flag to show the shell
      // and re-auth via /api/marketing/auth/refresh.
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
