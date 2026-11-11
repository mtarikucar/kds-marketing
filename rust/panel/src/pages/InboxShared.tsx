import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Bot, MessageCircle, Settings, Smartphone, User } from 'lucide-react';
import { useSession } from '@/auth/useSession';
import { listTeam } from '@/api/team';
import type { InboxAuthor } from '@/api/types';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/roles';

export const selectClass = 'w-full min-w-0 rounded-md border border-input bg-surface px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
export const columnClass =
  'min-w-0 border-t border-border bg-surface p-4 sm:p-5 flex flex-col gap-4 [overflow-wrap:anywhere]';
/** The inbox is one working surface. These panes share dividers, never individual card frames. */
export const conversationClass =
  'min-w-0 flex flex-col gap-4 bg-surface px-4 py-4 sm:px-6 lg:min-h-0 lg:overflow-y-auto [overflow-wrap:anywhere]';
export const journeyClass =
  'inbox-journey min-w-0 flex flex-col gap-4 border-t border-border bg-surface-muted/60 px-4 py-4 text-sm lg:max-h-72 lg:overflow-y-auto xl:max-h-none xl:min-h-0 xl:border-l xl:border-t-0 [overflow-wrap:anywhere]';
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
const HOUR = 3_600_000;

/** A time left, in days and hours, hours and minutes, or minutes. */
export function durationText(t: TFunction, ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return t('inbox.public.time.days', { days, hours });
  if (hours > 0) return t('inbox.public.time.hours', { hours, minutes: minutes % 60 });
  return t('inbox.public.time.minutes', { minutes });
}

/** A deadline as its time left, red under two hours (spec §9); "passed" once it is. */
export function Deadline({ at }: { at: string }) {
  const { t } = useTranslation();
  const left = new Date(at).getTime() - Date.now();
  const urgent = left < 2 * HOUR;
  return (
    <span
      data-testid="deadline"
      data-urgent={urgent ? 'true' : 'false'}
      className={`text-xs font-medium ${urgent ? 'text-danger' : 'text-muted-foreground'}`}
    >
      {left <= 0 ? t('inbox.public.deadlinePassed') : t('inbox.public.deadlineLeft', { time: durationText(t, left) })}
    </span>
  );
}

export function InboxTime({ at }: { at: string }) {
  const { i18n } = useTranslation();
  return (
    <time className="text-xs text-muted-foreground" dateTime={at}>
      {formatDateTime(at, i18n.language)}
    </time>
  );
}
/** The workspace's members, shared by every inbox view that names one. */
export function useInboxTeam() {
  const key = useInboxKey();
  const session = useSession();
  return useQuery({
    queryKey: [...key, 'team'],
    queryFn: listTeam,
    enabled: can(session.data, 'workspace.read'),
  });
}
/** A workspace user as shown: "You", a member's name or e-mail, else "Team member"; never an id. */
export function useMemberName() {
  const { t } = useTranslation();
  const session = useSession();
  const team = useInboxTeam();
  return (userId: string) => {
    if (userId === session.data?.user_id) return t('inbox.you');
    const member = team.data?.find((m) => m.user_id === userId);
    return member?.display_name || member?.email || t('inbox.teamMember');
  };
}
export function InboxActorLabel({ actor }: { actor: InboxAuthor }) {
  const { t } = useTranslation();
  const memberName = useMemberName();
  const kind = typeof actor === 'object' ? 'human' : actor;
  const Icon =
    kind === 'human'
      ? User
      : kind === 'agent'
        ? Bot
        : kind === 'customer'
          ? MessageCircle
          : kind === 'business_app'
            ? Smartphone
            : Settings;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {t(`inbox.actor.${kind}`)}
      {typeof actor === 'object' ? ` · ${memberName(actor.human)}` : ''}
    </span>
  );
}
