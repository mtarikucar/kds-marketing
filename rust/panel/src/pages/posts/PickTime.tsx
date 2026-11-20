import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CalendarClock } from 'lucide-react';
import { isApiError } from '@/api/client';
import { postsList, type PostFormat } from '@/api/posts';
import type { PickRef } from '@/api/postsPage';
import * as social from '@/api/social';
import { Button, cn } from '@/components/ui';
import { inputClass, useStudioKey } from '../StudioShared';
import { useInvalidatePosts } from './queries';
import { suggestTimes } from './suggestTimes';
import { whenWords } from './words';

/** The posting engine's refusal codes a person can read; any other shows as the server says it. */
const REFUSALS = [
  'lead_too_short', 'beyond_horizon', 'quiet_hours', 'cap_per_day', 'spacing', 'format_unsupported', 'media_count', 'media_type',
  'version_already_scheduled', 'area_redo_open', 'version_made_for_another_account', 'account_paused',
] as const;

/** Why the server refused a time: the first refused post's reason, in words when it is known. */
export function refusalText(t: TFunction, error: unknown): string {
  if (!isApiError(error)) return String(error);
  const items = error.details.items;
  const first = Array.isArray(items) ? (items[0] as { reason?: unknown } | undefined)?.reason : undefined;
  const code = String(first ?? error.details.reason ?? error.message);
  const known = REFUSALS.find((r) => r === code);
  return known ? t(`socialAccounts.refusal.${known}`) : code;
}

/**
 * "Zaman seç" (§2.6 `pick_time`, and `Zamanı ben seçeyim`): a person gives a waiting version its
 * account and time now instead of waiting for an agent (`social.version_schedule`). The account
 * as text when only one can take it, a few one-tap times derived from the account's own posts,
 * and one field for another time; the engine checks every time as it checks the agent's.
 */
export function PickTime({ pick, format }: { pick: PickRef; format: PostFormat | null }) {
  const { t, i18n } = useTranslation();
  const refresh = useInvalidatePosts();
  const studioKey = useStudioKey();
  const [account, setAccount] = useState(pick.accounts[0] ?? '');
  const [at, setAt] = useState('');
  const accounts = useQuery({ queryKey: ['social', 'accounts', 'names'], queryFn: social.accountsList, staleTime: 60_000 });
  const posts = useQuery({ queryKey: [...studioKey, 'posts', 'pick'], queryFn: () => postsList({ from: new Date(Date.now() - 100 * 86_400_000).toISOString() }), staleTime: 60_000 });
  // One key per attempt: a retry of the same choice replays, a new choice is a new request.
  const requestKey = useRef<{ choice: string; key: string } | null>(null);
  const schedule = useMutation({
    mutationFn: (publishAt: string) => {
      const choice = `${account}|${publishAt}`;
      if (requestKey.current?.choice !== choice) requestKey.current = { choice, key: crypto.randomUUID() };
      return social.versionSchedule({ project_id: pick.project_id, version_id: pick.version_id, capability_id: account, publish_at: publishAt, request_key: requestKey.current.key });
    },
    onSuccess: async () => {
      requestKey.current = null;
      await refresh();
    },
  });
  const name = (id: string) => accounts.data?.find((a) => a.capability_id === id)?.name ?? t('socialAccounts.unknownAccount');
  const settings = posts.data?.settings;
  const suggestions = settings && format
    ? suggestTimes({ format, capabilityId: account, settings, posts: posts.data?.posts ?? [], published: [] })
    : [];
  if (schedule.isSuccess) return <p role="status" className="text-sm text-success">{t('socialAccounts.scheduled')}</p>;
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-border bg-surface-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {pick.accounts.length === 1 ? (
          <span className="font-medium">{t('socialAccounts.onAccount', { account: name(account) })}</span>
        ) : (
          <label className="flex items-center gap-2">
            <span>{t('socialAccounts.scheduleAccount')}</span>
            <select className={cn(inputClass, 'w-auto py-1.5')} value={account} onChange={(e) => { setAccount(e.target.value); schedule.reset(); }}>
              {pick.accounts.map((id) => <option key={id} value={id}>{name(id)}</option>)}
            </select>
          </label>
        )}
        {suggestions.map((s) => (
          <Button key={s} size="sm" variant="outline" disabled={schedule.isPending} aria-label={t('socialAccounts.scheduleAtSuggestion', { at: whenWords(t, s, i18n.language) })} onClick={() => schedule.mutate(s)}>
            <CalendarClock aria-hidden="true" className="h-4 w-4" />
            {whenWords(t, s, i18n.language)}
          </Button>
        ))}
      </div>
      {suggestions.length > 0 && <p className="text-xs text-muted-foreground">{t('socialAccounts.suggestionsHelp')}</p>}
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (at && !schedule.isPending) schedule.mutate(new Date(at).toISOString()); }}>
        <label className="flex min-w-0 flex-col gap-1 text-xs">
          <span>{t(suggestions.length ? 'socialAccounts.otherTime' : 'socialAccounts.scheduleAt')}</span>
          <input type="datetime-local" className={cn(inputClass, 'py-1.5')} value={at} onChange={(e) => { setAt(e.target.value); schedule.reset(); }} required />
        </label>
        <Button size="sm" type="submit" disabled={!at || !account} loading={schedule.isPending}>{t('socialAccounts.schedule')}</Button>
      </form>
      {schedule.error != null && <p role="alert" className="text-sm text-danger">{t('socialAccounts.scheduleRefused', { reason: refusalText(t, schedule.error) })}</p>}
    </div>
  );
}
