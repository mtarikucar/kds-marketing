import { useQueries, useQuery } from '@tanstack/react-query';
import * as api from '@/api/social';
import { pending } from '@/api/studio';
import { postsList } from '@/api/posts';
import { useSession } from '@/auth/useSession';
import { useStudioKey } from '../StudioShared';

/** Everything the social page reads from `/api/social`, under the workspace. */
export function useSocialKey() {
  const session = useSession();
  return ['social', session.data?.current_workspace] as const;
}

/** The first and last day of a period of `days` days ending today (as the server reads them). */
export function periodRange(days: number): { from: string; until: string } {
  const until = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(until) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, until };
}

/**
 * The planned posts from a hundred days back on, and the posting settings with them (one read:
 * the timeline's visuals and the settings' values). Under Studio's key, so a write there (an
 * approval, a time given) refreshes it.
 */
export function usePostsKey() {
  const from = `${new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`;
  return [...useStudioKey(), 'posts', 'list', from] as const;
}
export function usePostsRead(enabled: boolean) {
  const key = usePostsKey();
  return useQuery({ queryKey: key, queryFn: () => postsList({ from: key[4] }), enabled, refetchInterval: 60_000 });
}

export function useAccounts(enabled: boolean) {
  const key = useSocialKey();
  return useQuery({ queryKey: [...key, 'accounts'], queryFn: api.accountsList, enabled, staleTime: 30_000 });
}

/** Each account's detail over `days` days, read side by side. */
export function useAccountDetails(ids: string[], days: number) {
  const key = useSocialKey();
  const { from, until } = periodRange(days);
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: [...key, 'account', id, from, until],
      queryFn: () => api.accountGet(id, from, until),
      refetchInterval: 60_000,
    })),
  });
}

/** Studio's pending work: what waits for a person (approvals, TikTok screens, failed sends). */
export function usePending(enabled: boolean) {
  const key = useStudioKey();
  return useQuery({ queryKey: [...key, 'pending'], queryFn: pending, enabled, refetchInterval: 30_000 });
}

export function usePackages(enabled: boolean) {
  const key = useSocialKey();
  return useQuery({ queryKey: [...key, 'packages'], queryFn: api.packagesWaiting, enabled, refetchInterval: 60_000 });
}
