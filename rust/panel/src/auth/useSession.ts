import { useQuery } from '@tanstack/react-query';
import { me } from '@/api/auth';
import { isApiError } from '@/api/client';
import type { MeOut } from '@/api/types';

/** Query keys under `session` are cleared together on sign-in, sign-out and switching. */
export const SESSION_KEY = ['session'] as const;
const OPTIONAL_SESSION_KEY = ['session', 'optional'] as const;

/** The signed-in user (`GET /api/auth/me`); a 401 sends the browser to the sign-in page. */
export function useSession() {
  return useQuery<MeOut>({
    queryKey: SESSION_KEY,
    queryFn: () => me(),
    staleTime: 30_000,
  });
}

/** The signed-in user, or `null` for a visitor: for public pages that adapt to either. */
export function useOptionalSession() {
  return useQuery<MeOut | null>({
    queryKey: OPTIONAL_SESSION_KEY,
    queryFn: async () => {
      try {
        return await me({ redirectOn401: false });
      } catch (err) {
        if (isApiError(err) && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 30_000,
  });
}
