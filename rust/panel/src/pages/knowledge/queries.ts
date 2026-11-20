import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getKnowledge, type KnowledgeOut } from '@/api/knowledge';
import { isApiError } from '@/api/client';
import { useSession } from '@/auth/useSession';

/** Every knowledge read's key starts with this (design §4.11: one read, `GET /api/knowledge`). */
export const KNOWLEDGE_KEY = ['knowledge'] as const;

/** How often the page reads again while an agent still has something to do with it (a note, a derivation). */
export const KNOWLEDGE_BUSY_MS = 15_000;
/** How often it reads again otherwise: an agent may still file, propose or derive meanwhile. */
export const KNOWLEDGE_IDLE_MS = 60_000;

/** The page's refresh: often while a note is open or a derivation is due, else now and then. */
export function knowledgeRefresh(data: KnowledgeOut | undefined): number {
  const busy = !!data && (data.notes.some((n) => n.status === 'open') || (data.frame?.derive_due.length ?? 0) > 0);
  return busy ? KNOWLEDGE_BUSY_MS : KNOWLEDGE_IDLE_MS;
}

/**
 * The knowledge base of the current workspace; every page that needs a fact of it reads this.
 * `live`: the page that shows it whole reads it again on its own, since agents change it too.
 */
export function useKnowledge(options: { enabled?: boolean; live?: boolean } = {}) {
  const workspace = useSession().data?.current_workspace;
  return useQuery({
    queryKey: [...KNOWLEDGE_KEY, workspace ?? undefined],
    queryFn: getKnowledge,
    enabled: !!workspace && (options.enabled ?? true),
    ...(options.live ? { refetchInterval: (query: { state: { data: KnowledgeOut | undefined } }) => knowledgeRefresh(query.state.data), refetchOnWindowFocus: true } : {}),
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

/**
 * A knowledge write: reads the knowledge base again on success, and on a stale revision too.
 * `onError` runs before that read, while what it is about is still drawn: a refusal that the
 * read makes disappear (a proposal no longer pending) is told by whoever stays.
 */
export function useKnowledgeMutation<T, R>(
  fn: (value: T) => Promise<R>,
  onSuccess?: (out: R, value: T) => void | Promise<void>,
  onError?: (err: unknown, value: T) => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (out, value) => {
      await onSuccess?.(out, value);
      await invalidateKnowledge(client);
    },
    onError: async (err, value) => {
      onError?.(err, value);
      if (isStale(err)) await invalidateKnowledge(client);
    },
  });
}

/** The refusals that mean "it changed since you read it": the page reloads and says so. */
const STALE = new Set([
  'card_changed',
  'card_archived',
  'rules_changed',
  'goals_changed',
  'note_changed',
  'proposal_superseded',
  'proposal_expired',
  'proposal_closed',
  'note_closed',
  'note_withdrawn',
]);

/** Whether `err` says the subject changed since it was read. */
export function isStale(err: unknown): boolean {
  return isApiError(err) && err.code === 'CONFLICT' && typeof err.details.reason === 'string' && STALE.has(err.details.reason);
}
