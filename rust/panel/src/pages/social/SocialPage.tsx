import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { LockKeyhole, Pause } from 'lucide-react';
import * as api from '@/api/social';
import { pending } from '@/api/studio';
import { useSession } from '@/auth/useSession';
import { ModuleStatusLine } from '@/components/ModuleStatusLine';
import { WorkspaceHeader } from '@/components/WorkspaceHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { can } from '@/lib/roles';
import { formatDateTime } from '@/lib/format';
import { buttonClass, StudioReadStatus, useStudioKey } from '../StudioShared';
import { AccountView } from './AccountView';
import { AccountSettings } from './AccountSettings';
import { WaitingPackages } from './WaitingPackages';
import { TiktokSlot } from './TiktokSlot';
import { ApprovalSlot } from './ApprovalSlot';

export function SocialPage() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const studioKey = useStudioKey();
  const allowed = can(session.data, 'social.work');
  const manage = can(session.data, 'social.manage');
  const key = ['social', session.data?.current_workspace] as const;
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? params.get('section');
  const tab = raw === 'packages' ? 'packages' : raw === 'settings' || (raw === 'posts' && params.get('view') === 'settings') ? 'settings' : 'accounts';
  const requestedSlot = params.get('tiktok') ?? params.get('slot');
  const work = useQuery({ queryKey: [...studioKey, 'pending'], queryFn: pending, enabled: allowed && !!requestedSlot });
  const waiting = !!work.data?.blockers.some(b => 'slot' in b.target && b.target.slot === requestedSlot && b.next_action === 'tiktok_posting_screen');
  const tiktok = params.get('tiktok') ?? (waiting ? requestedSlot : null);
  // A post whose connection asks for a person's approval (B35): opened from the home feed or
  // from the account's upcoming post.
  const slotParam = !tiktok && work.isSuccess ? params.get('slot') : null;
  const awaitsApproval = !!work.data?.approvals.some(target => 'slot' in target && target.slot === slotParam);
  // Once opened it stays open while the person approves: the approval itself ends the waiting.
  const [approving, setApproving] = useState<string | null>(null);
  useEffect(() => { if (awaitsApproval && slotParam) setApproving(slotParam); }, [awaitsApproval, slotParam]);
  const approvalSlot = slotParam && (awaitsApproval || approving === slotParam) ? slotParam : null;
  const accounts = useQuery({ queryKey: [...key, 'accounts'], queryFn: api.accountsList, enabled: allowed, staleTime: 30_000 });
  const selected = accounts.data?.find(a => a.capability_id === params.get('account'));
  const account = selected ?? accounts.data?.[0];
  const openTab = (next: string) => setParams(next === 'accounts' ? {} : { tab: next });
  return <div data-testid="social" className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
    <WorkspaceHeader scene="studio" title={t('modulePages.social')} />
    {!allowed ? <p role="alert">{t('studio.forbidden')}</p> : <>
      <ModuleStatusLine module="social" />
      <Tabs value={tab} onValueChange={openTab}>
        <TabsList aria-label={t('modulePages.social')} className="flex flex-wrap">
          <TabsTrigger value="accounts">{t('socialAccounts.accounts')}</TabsTrigger>
          <TabsTrigger value="packages">{t('socialAccounts.packages')}</TabsTrigger>
          <TabsTrigger value="settings">{t('modulePages.settings')}</TabsTrigger>
        </TabsList>
        <TabsContent value="accounts">
          {requestedSlot && <StudioReadStatus query={work} />}
          {tiktok ? <div className="space-y-4"><button className={buttonClass} onClick={() => setParams({})}>{t('socialAccounts.back')}</button>{work.isSuccess && <TiktokSlot id={tiktok} manage={manage} waiting={waiting} />}</div>
          : approvalSlot ? <div className="space-y-4"><button className={buttonClass} onClick={() => setParams({})}>{t('socialAccounts.back')}</button><ApprovalSlot key={approvalSlot} id={approvalSlot} manage={manage} waiting={awaitsApproval} /></div> : <>
            <StudioReadStatus query={accounts} />
            {accounts.isSuccess && accounts.data.length === 0 && <div className="space-y-4 py-10 text-center"><p>{t('socialAccounts.empty')}</p><Link className={buttonClass} to="/connect">{t('socialAccounts.connect')}</Link></div>}
            {!!accounts.data?.length && <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(12rem,15rem)_minmax(0,1fr)]">
              <aside aria-label={t('socialAccounts.accounts')} className={`${selected ? 'hidden md:block' : 'block'} min-w-0 space-y-4 md:border-e md:border-border md:pe-5`}>
                <h2 className="text-sm font-semibold">{t('socialAccounts.accounts')}</h2>
                <ul className="space-y-1">{accounts.data.map(row => {
                  const label = `${row.name} · ${t(`capabilities.kinds.${row.kind}`)}${row.paused ? ` · ${t('socialAccounts.paused')}` : ''}${row.status !== 'verified' ? ` · ${t('socialAccounts.locked')}` : ''}`;
                  return <li key={row.capability_id}><button aria-label={label} aria-pressed={row.capability_id === account?.capability_id} onClick={() => setParams({ account: row.capability_id })} className="w-full min-w-0 space-y-1 rounded-md px-3 py-3 text-start hover:bg-surface-muted aria-pressed:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium"><span className="min-w-0 break-all">{row.name}</span>{row.paused && <Pause aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}{row.status !== 'verified' && <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}</span>
                    <span className="block text-xs text-muted-foreground">{t(`capabilities.kinds.${row.kind}`)}</span>
                    {row.paused && <span className="block text-xs text-muted-foreground">{t('socialAccounts.paused')}</span>}
                    {row.status !== 'verified' && <span className="block text-xs text-muted-foreground">{t(`status.capability.${row.status}`, { defaultValue: t('socialAccounts.locked') })}</span>}
                    {row.next && <span className="block text-xs text-muted-foreground">{formatDateTime(row.next.publish_at, i18n.language)} · {t(`posts.format.${row.next.format}`, { defaultValue: row.next.format })}</span>}
                  </button></li>;
                })}</ul>
                <Link className={`${buttonClass} w-full`} to="/connect">{t('socialAccounts.connect')}</Link>
              </aside>
              {account && <div className={`${selected ? 'block' : 'hidden md:block'} min-w-0`}><AccountView key={account.capability_id} account={account} queryKey={key} back={() => setParams({})} /></div>}
            </div>}
          </>}
        </TabsContent>
        <TabsContent value="packages"><WaitingPackages accounts={accounts.data ?? []} queryKey={key} /></TabsContent>
        <TabsContent value="settings"><AccountSettings accounts={accounts.data ?? []} queryKey={key} manage={manage} /></TabsContent>
      </Tabs>
    </>}
  </div>;
}
