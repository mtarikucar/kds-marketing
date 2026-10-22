import type { QueryClient } from '@tanstack/react-query';

/** Every capability list key starts with `capabilities`. */
export const CAPABILITIES_KEY = ['capabilities'] as const;
export const GROUPS_KEY = ['capability-groups'] as const;
export const BUDGET_ITEMS_KEY = ['budget', 'items'] as const;

/**
 * After a capability or group change: the lists, the pending work (verify / connect items) and
 * the strategy (its channel and group gaps read the capabilities).
 */
export async function invalidateCapabilities(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: CAPABILITIES_KEY }),
    queryClient.invalidateQueries({ queryKey: GROUPS_KEY }),
    queryClient.invalidateQueries({ queryKey: ['work', 'pending'] }),
    queryClient.invalidateQueries({ queryKey: ['strategy'] }),
  ]);
}
