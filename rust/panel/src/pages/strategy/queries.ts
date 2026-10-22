import type { QueryClient } from '@tanstack/react-query';

/** `GET /api/strategy`. Every strategy query key starts with `strategy`. */
export const STRATEGY_KEY = ['strategy', 'current'] as const;
export const VERSIONS_KEY = ['strategy', 'versions'] as const;
export const PENDING_KEY = ['work', 'pending'] as const;
export const GROUPS_KEY = ['capability-groups'] as const;

/** After any strategy change: the strategy, its logs and versions, and the pending work. */
export async function invalidateStrategy(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['strategy'] }),
    queryClient.invalidateQueries({ queryKey: PENDING_KEY }),
  ]);
}
