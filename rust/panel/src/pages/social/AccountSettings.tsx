import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/social';
import { StudioError, StudioReadStatus } from '../StudioShared';
import { PostsSettings } from '../posts/PostsSettings';
import { usePostsKey } from '../posts/PostsShared';

export function AccountSettings({ accounts, queryKey, manage }: { accounts: api.SocialAccount[]; queryKey: readonly unknown[]; manage: boolean }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const postsKey = [...usePostsKey(), 'list'];
  const settingsKey = [...queryKey, 'settings'];
  const settings = useQuery({ queryKey: settingsKey, queryFn: api.postingSettings, enabled: manage, staleTime: 0 });
  const pause = useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => api.accountPause(id, paused, settings.data!.settings.revision),
    onSuccess: result => {
      client.setQueryData(settingsKey, { settings: result });
      client.setQueryData(postsKey, (old: { settings: unknown } | undefined) => old ? { ...old, settings: result } : old);
      client.setQueryData<api.SocialAccount[]>([...queryKey, 'accounts'], old => old?.map(account => ({ ...account, paused: result.paused_capability_ids.includes(account.capability_id) })));
    },
    // A stale revision must be read again; never retry a write with a guessed revision.
    onError: () => { void settings.refetch(); },
  });
  const revision = settings.data?.settings.revision;
  return <div className="min-w-0 space-y-6">
    <PostsSettings />
    {manage && <section aria-label={t('socialAccounts.accountSettings')} className="space-y-3">
      <h2 className="font-semibold">{t('socialAccounts.accountSettings')}</h2>
      <StudioReadStatus query={settings} />
      <ul className="divide-y divide-border">{accounts.map(account => {
        const paused = settings.data?.settings.paused_capability_ids.includes(account.capability_id) ?? account.paused;
        const label = t(paused ? 'socialAccounts.resume' : 'socialAccounts.pause');
        return <li key={account.capability_id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3">
          <span className="min-w-0 break-all text-sm">{account.name} · {t(`capabilities.kinds.${account.kind}`)}</span>
          <button type="button" role="switch" aria-checked={paused} aria-label={`${account.name} · ${label}`} disabled={pause.isPending || settings.isFetching || settings.isError || !Number.isInteger(revision)} onClick={() => pause.mutate({ id: account.capability_id, paused: !paused })} className="flex min-h-11 items-center gap-2 text-sm disabled:opacity-50">
            <span aria-hidden="true" className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 ${paused ? 'justify-end bg-primary' : 'bg-border'}`}><span className="h-4 w-4 rounded-full bg-surface" /></span>{label}
          </button>
        </li>;
      })}</ul>
      <StudioError error={pause.error} />
    </section>}
  </div>;
}
