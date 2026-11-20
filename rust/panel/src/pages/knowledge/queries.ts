import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getKnowledge } from '@/api/knowledge';
import { isApiError } from '@/api/client';
import { useSession } from '@/auth/useSession';

/** Every knowledge read's key starts with this (design §4.11: one read, `GET /api/knowledge`). */
export const KNOWLEDGE_KEY = ['knowledge'] as const;

/** The knowledge base of the current workspace; every page that needs a fact of it reads this. */
export function useKnowledge(options: { enabled?: boolean } = {}) {
  const workspace = useSession().data?.current_workspace;
  return useQuery({
    queryKey: [...KNOWLEDGE_KEY, workspace ?? undefined],
    queryFn: getKnowledge,
    enabled: !!workspace && (options.enabled ?? true),
  });
}

/**
 * What a knowledge write changes besides the read itself: the pending work (the empty item, the
 * proposals), the compatibility read older pages use (`/api/strategy`) and the onboarding step.
 */
export async function invalidateKnowledge(client: QueryClient) {
  await Promise.all([
    client.invalidateQueries({ queryKey: KNOWLEDGE_KEY }),
    client.invalidateQueries({ queryKey: ['work'] }),
    client.invalidateQueries({ queryKey: ['strategy'] }),
  ]);
}

/** A knowledge write: reads the knowledge base again on success, and on a stale revision too. */
export function useKnowledgeMutation<T, R>(fn: (value: T) => Promise<R>, onSuccess?: (out: R, value: T) => void | Promise<void>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (out, value) => {
      await onSuccess?.(out, value);
      await invalidateKnowledge(client);
    },
    onError: async (err) => {
      if (isStale(err)) await invalidateKnowledge(client);
    },
  });
}

/** The refusals that mean "it changed since you read it": the page reloads and says so. */
const STALE = new Set(['card_changed', 'rules_changed', 'goals_changed', 'note_changed', 'proposal_superseded', 'proposal_expired', 'proposal_closed', 'note_closed', 'note_withdrawn']);

/** Whether `err` says the subject changed since it was read. */
export function isStale(err: unknown): boolean {
  return isApiError(err) && err.code === 'CONFLICT' && typeof err.details.reason === 'string' && STALE.has(err.details.reason);
}
