import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bot, MessageCircle, Settings, User } from 'lucide-react';
import { useSession } from '@/auth/useSession';
import type { InboxActor } from '@/api/types';
import { formatDateTime } from '@/lib/format';

export const selectClass = 'w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm';
export const columnClass =
  'min-w-0 rounded-xl border border-border bg-card p-4 flex flex-col gap-4 [overflow-wrap:anywhere]';
export function useInboxKey() {
  const session = useSession();
  return ['inbox', session.data?.current_workspace] as const;
}
export function useInboxMutation<T = void>(
  mutationFn: (input: T) => Promise<unknown>,
  onSuccess?: () => void,
) {
  const client = useQueryClient();
  const key = useInboxKey();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      onSuccess?.();
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({ queryKey: ['work', 'pending'] }),
      ]);
    },
  });
}
export function InboxTime({ at }: { at: string }) {
  const { i18n } = useTranslation();
  return (
    <time className="text-xs text-muted-foreground" dateTime={at}>
      {formatDateTime(at, i18n.language)}
    </time>
  );
}
export function InboxActorLabel({ actor }: { actor: InboxActor | 'customer' }) {
  const { t } = useTranslation();
  const kind = typeof actor === 'object' ? 'human' : actor;
  const Icon =
    kind === 'human' ? User : kind === 'agent' ? Bot : kind === 'customer' ? MessageCircle : Settings;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {t(`inbox.actor.${kind}`)}
      {typeof actor === 'object' ? ` · ${actor.human}` : ''}
    </span>
  );
}
