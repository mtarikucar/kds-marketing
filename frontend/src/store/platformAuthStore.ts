import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface PlatformOperator {
  id: string;
  email: string;
  name: string;
}

interface PlatformAuthState {
  operator: PlatformOperator | null;
  accessToken: string | null;
  isAuthenticated: boolean;

  login: (operator: PlatformOperator, accessToken: string) => void;
  logout: () => void;
}

/**
 * Platform (superadmin) realm store — separate from the marketing-user
 * store on purpose: different token, different audience, and an operator
 * may be logged into both at once. No refresh flow (12h access token);
 * the token stays in memory only, same XSS stance as the marketing store.
 */
export const usePlatformAuthStore = create<PlatformAuthState>()(
  persist(
    (set) => ({
      operator: null,
      accessToken: null,
      isAuthenticated: false,

      login: (operator, accessToken) =>
        set({ operator, accessToken, isAuthenticated: true }),

      logout: () =>
        set({ operator: null, accessToken: null, isAuthenticated: false }),
    }),
    {
      name: 'platform-auth-storage',
      // Per-tab isolation (sessionStorage) — same rationale as the marketing
      // store: one tab's login/logout must not change the operator in others.
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        operator: state.operator,
        // isAuthenticated is NOT persisted: without a token a restored
        // "authenticated" shell would just 401 on first call — force a
        // clean login after reload instead.
      }),
    },
  ),
);
