import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { listTasks } from '@/api/research';
import { getStrategy } from '@/api/strategy';
import { useLeadsKey } from '../LeadsShared';

/** The most tasks one read answers (the server's page limit). */
const PAGE = 200;

/** The open tasks, newest first: few (one per ICP entry, and the one-off ones), read in one go. */
export function useOpenTasks() {
  const key = useLeadsKey();
  return useQuery({ queryKey: [...key, 'research', 'list', 'open'], queryFn: () => listTasks({ status: 'open', limit: PAGE }) });
}

/** Every task, newest first, a page at a time: the closed ones are read from it. */
export function useAllTasks() {
  const key = useLeadsKey();
  return useInfiniteQuery({
    queryKey: [...key, 'research', 'list', 'all'],
    queryFn: ({ pageParam }) => listTasks({ limit: PAGE, before_at: pageParam?.before_at, before_id: pageParam?.before_id }),
    initialPageParam: undefined as { before_at: string; before_id: string } | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

/**
 * The audience segments' names by key, from the approved strategy (the pool's own read); empty
 * while it cannot be read, and a task is then named by what it looks for.
 */
export function useSegmentNames(): ReadonlyMap<string, string> {
  const key = useLeadsKey();
  const strategy = useQuery({ queryKey: [...key, 'prospects', 'audience'], queryFn: getStrategy, retry: false });
  return useMemo(
    () => new Map((strategy.data?.approved?.sections.audience ?? []).filter((s) => s.name).map((s) => [s.key, s.name])),
    [strategy.data],
  );
}
