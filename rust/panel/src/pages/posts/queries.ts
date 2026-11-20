import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { isApiError } from '@/api/client';
import { postGet, postsRead, type PostsFilter, type PostsOut } from '@/api/postsPage';
import { useSession } from '@/auth/useSession';
import { toast } from '@/components/ui';
import { useStudioKey } from '../StudioShared';

/** Every read of the page starts with this key; every action of the page invalidates it (§3.8). */
export const POSTS_KEY = ['posts'] as const;

function useWorkspace() {
  return useSession().data?.current_workspace ?? undefined;
}

/**
 * `content.posts` for `filter`, 50 rows a page, the next page on `Daha fazla göster` (§3.2.6).
 * The counts, the special days, the composer's state and the brake come with every page; the
 * first page's are the page's.
 */
export function usePosts(filter: PostsFilter | undefined, enabled = true) {
  const workspace = useWorkspace();
  return useInfiniteQuery({
    queryKey: [...POSTS_KEY, workspace, 'list', filter ?? 'all'],
    queryFn: ({ pageParam }) => postsRead({ filter, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: PostsOut) => last.next_cursor ?? undefined,
    enabled: enabled && !!workspace,
    refetchInterval: 30_000,
  });
}

/** `content.post_get` of the selected row: its whole text and materials (§3.3). */
export function usePostDetail(rowId: string | undefined) {
  const workspace = useWorkspace();
  return useQuery({
    queryKey: [...POSTS_KEY, workspace, 'row', rowId],
    queryFn: () => postGet(rowId!),
    enabled: !!workspace && !!rowId,
    retry: false,
    refetchInterval: 30_000,
  });
}

/**
 * What a write on the page changes: the page's reads, Studio's (the library, the TikTok screen,
 * the posting settings), the pending work and the home page's items.
 */
export async function invalidatePosts(client: QueryClient, studioKey: readonly unknown[]) {
  await Promise.all([
    client.invalidateQueries({ queryKey: POSTS_KEY }),
    client.invalidateQueries({ queryKey: studioKey }),
    client.invalidateQueries({ queryKey: ['work'] }),
    client.invalidateQueries({ queryKey: ['social'] }),
  ]);
}

/** Refreshes the page's reads after a write made elsewhere (a drawer, the TikTok dialog). */
export function useInvalidatePosts() {
  const client = useQueryClient();
  const studioKey = useStudioKey();
  return () => invalidatePosts(client, studioKey);
}

/** The refusal that means "it changed since you read it" (§2.7.4). */
export function isConflict(err: unknown): boolean {
  return isApiError(err) && err.code === 'CONFLICT';
}

/**
 * A write on a row. Success reads the page again; a `CONFLICT` (the post changed since it was
 * read) reads the row again and says so, never retrying with a guessed revision.
 */
export function usePostsMutation<T, R>(fn: (value: T) => Promise<R>, onSuccess?: (out: R, value: T) => void | Promise<void>) {
  const client = useQueryClient();
  const studioKey = useStudioKey();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (out, value) => {
      await onSuccess?.(out, value);
      await invalidatePosts(client, studioKey);
    },
    onError: async (err) => {
      if (isConflict(err)) {
        toast.message(t('postsPage.panel.changed'));
        await invalidatePosts(client, studioKey);
      }
    },
  });
}

/** Whether `query` matches now, followed as the window changes (phone and tablet layouts, §2.10). */
export function useMedia(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const change = () => setMatches(list.matches);
    change();
    list.addEventListener?.('change', change);
    return () => list.removeEventListener?.('change', change);
  }, [query]);
  return matches;
}
