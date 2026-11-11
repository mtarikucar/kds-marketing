import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/social';
import { formatDateTime } from '@/lib/format';
import { StudioReadStatus } from '../StudioShared';

/** Why nothing can take a version, as `social.versions_waiting` says it. */
const BLOCKED = [
  'no_approved_strategy',
  'no_connected_account',
  'account_paused',
  'its_account_unavailable',
  'format_not_supported',
  'channel_not_in_strategy',
  'hypothesis_does_not_post',
] as const;

export function WaitingPackages({ accounts, queryKey }: { accounts: api.SocialAccount[]; queryKey: readonly unknown[] }) {
  const { t, i18n } = useTranslation();
  const packages = useQuery({ queryKey: [...queryKey, 'packages'], queryFn: api.packagesWaiting });
  return <section aria-label={t('socialAccounts.packages')} className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
    <p className="text-sm text-muted-foreground">{t('socialAccounts.packageHelp')}</p>
    <StudioReadStatus query={packages} />
    {packages.isSuccess && !packages.data.length && <p>{t('socialAccounts.noPackages')}</p>}
    {packages.data?.map(pack => <article key={pack.project_id} className="space-y-3 rounded-lg border border-border p-4">
      <h2 className="font-semibold">{pack.goal}</h2><p className="text-sm">{pack.summary}</p>
      <time dateTime={pack.delivered_at} className="text-xs text-muted-foreground">{formatDateTime(pack.delivered_at, i18n.language)}</time>
      <ul className="divide-y divide-border">{pack.versions.map(version => <li key={version.version_id} className="space-y-2 py-3">
        <h3 className="text-sm font-medium">{t(`posts.format.${version.format}`, { defaultValue: version.format })}</h3>
        <p className="max-w-prose whitespace-pre-wrap text-sm">{version.text}</p>
        <p className="text-xs text-muted-foreground">{t('socialAccounts.materials', { count: version.material_ids.length })}</p>
        {version.accounts.length
          ? <p className="text-xs text-muted-foreground">{version.accounts.map(id => accounts.find(a => a.capability_id === id)?.name ?? t('socialAccounts.unknownAccount')).join(' · ')}</p>
          : <p className="border-s-2 border-warning bg-warning-subtle px-3 py-2 text-sm">{(() => {
              const reason = BLOCKED.find(r => r === version.blocked);
              return reason ? t(`socialAccounts.blocked.${reason}`) : t('socialAccounts.noSuitableAccount');
            })()}</p>}
      </li>)}</ul>
    </article>)}
  </section>;
}
