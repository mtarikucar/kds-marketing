import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { isApiError } from '@/api/client';
import * as api from '@/api/social';
import { BLOCKED_REASONS } from '@/api/content';
import { formatDateTime } from '@/lib/format';
import { buttonClass, inputClass, StudioReadStatus, useStudioKey } from '../StudioShared';

type WaitingVersion = api.WaitingPackage['versions'][number];

/**
 * A person gives a waiting version its account and time (`social.version_schedule`), when they
 * do not want to wait for the agent's next run. The posting engine checks the time as it checks
 * the agent's (quiet hours, daily caps, spacing, lead, horizon) and says why it refuses one.
 */
function ScheduleVersion({ pack, version, accounts, queryKey }: { pack: api.WaitingPackage; version: WaitingVersion; accounts: api.SocialAccount[]; queryKey: readonly unknown[] }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  // The content page reads under Studio's key: its rows show the new post once it is planned.
  const studioKey = useStudioKey();
  const [account, setAccount] = useState(version.accounts[0] ?? '');
  const [at, setAt] = useState('');
  // One key per attempt: a retry of the same choice replays, a new choice is a new request.
  const requestKey = useRef<string | null>(null);
  const schedule = useMutation({
    mutationFn: () => {
      requestKey.current ??= crypto.randomUUID();
      return api.versionSchedule({ project_id: pack.project_id, version_id: version.version_id, capability_id: account, publish_at: new Date(at).toISOString(), request_key: requestKey.current });
    },
    onSuccess: async () => {
      requestKey.current = null;
      await Promise.all([client.invalidateQueries({ queryKey }), client.invalidateQueries({ queryKey: studioKey }), client.invalidateQueries({ queryKey: ['work'] })]);
    },
  });
  const reset = () => { requestKey.current = null; schedule.reset(); };
  const name = (id: string) => accounts.find(a => a.capability_id === id)?.name ?? t('socialAccounts.unknownAccount');
  const error = schedule.error;
  const reason = isApiError(error) ? String(error.details.reason ?? error.message) : error ? String(error) : '';
  return <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); if (account && at && !schedule.isPending) schedule.mutate(); }}>
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      <span>{t('socialAccounts.scheduleAccount')}</span>
      <select className={inputClass} value={account} onChange={e => { setAccount(e.target.value); reset(); }}>
        {version.accounts.map(id => <option key={id} value={id}>{name(id)}</option>)}
      </select>
    </label>
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      <span>{t('socialAccounts.scheduleAt')}</span>
      <input type="datetime-local" className={inputClass} value={at} onChange={e => { setAt(e.target.value); reset(); }} required />
    </label>
    <button type="submit" className={buttonClass} disabled={!account || !at || schedule.isPending}>{t('socialAccounts.schedule')}</button>
    {error && <p role="alert" className="basis-full text-sm text-danger">{t('socialAccounts.scheduleRefused', { reason })}</p>}
  </form>;
}

export function WaitingPackages({ accounts, queryKey }: { accounts: api.SocialAccount[]; queryKey: readonly unknown[] }) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const packages = useQuery({ queryKey: [...queryKey, 'packages'], queryFn: api.packagesWaiting });
  // A link from the content page names the version it is about: land on it once it is drawn.
  useEffect(() => {
    if (packages.data && location.hash.startsWith('#version-')) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView?.({ block: 'start' });
  }, [packages.data, location.hash]);
  return <section aria-label={t('socialAccounts.packages')} className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
    <p className="text-sm text-muted-foreground">{t('socialAccounts.packageHelp')}</p>
    <StudioReadStatus query={packages} />
    {packages.isSuccess && !packages.data.length && <p>{t('socialAccounts.noPackages')}</p>}
    {packages.data?.map(pack => <article key={pack.project_id} className="space-y-3 rounded-lg border border-border p-4">
      <h2 className="font-semibold">{pack.goal}</h2><p className="text-sm">{pack.summary}</p>
      <time dateTime={pack.delivered_at} className="text-xs text-muted-foreground">{formatDateTime(pack.delivered_at, i18n.language)}</time>
      <ul className="divide-y divide-border">{pack.versions.map(version => <li key={version.version_id} id={`version-${version.version_id}`} className="scroll-mt-4 space-y-2 py-3">
        <h3 className="text-sm font-medium">{t(`posts.format.${version.format}`, { defaultValue: version.format })}</h3>
        <p className="max-w-prose whitespace-pre-wrap text-sm">{version.text}</p>
        <p className="text-xs text-muted-foreground">{t('socialAccounts.materials', { count: version.material_ids.length })}</p>
        {version.accounts.length
          ? <>
              <p className="text-xs text-muted-foreground">{version.accounts.map(id => accounts.find(a => a.capability_id === id)?.name ?? t('socialAccounts.unknownAccount')).join(' · ')}</p>
              <ScheduleVersion pack={pack} version={version} accounts={accounts} queryKey={queryKey} />
            </>
          : <p className="border-s-2 border-warning bg-warning-subtle px-3 py-2 text-sm">{(() => {
              const reason = BLOCKED_REASONS.find(r => r === version.blocked);
              return reason ? t(`socialAccounts.blocked.${reason}`) : t('socialAccounts.noSuitableAccount');
            })()}</p>}
      </li>)}</ul>
    </article>)}
  </section>;
}
