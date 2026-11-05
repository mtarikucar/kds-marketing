import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Permission } from '@/api/types';
import { listKeys } from '@/api/apiKeys';
import { listTeam } from '@/api/team';
import { listCapabilities } from '@/api/capabilities';
import { getPending } from '@/api/work';
import { getWorkspace } from '@/api/workspace';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { Button, Callout, PageHeader } from '@/components/ui';
import { billingStage, useBilling } from './billing/queries';

function SetupStep({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return <li className="flex gap-4 border-b border-border py-6 last:border-b-0 sm:gap-6">
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-sm font-medium text-foreground">{number}</span>
    <div className="min-w-0 flex-1 space-y-3 text-sm leading-6">
      <h2 className="text-lg font-medium text-foreground">{title}</h2>
      {children}
    </div>
  </li>;
}

export function OnboardingPage() {
  const { t } = useTranslation();
  const session = useSession();
  const id = session.data?.current_workspace;
  const workspace = useQuery({queryKey:['workspace',id],queryFn:getWorkspace});
  const billing = useBilling('onboarding');
  const active = workspace.data?.status === 'active';
  const can = (permission: Permission) => workspace.data?.my_permissions.includes(permission) ?? false;
  const pending = useQuery({queryKey:['work','pending',id],queryFn:getPending,enabled:!!workspace.data && workspace.data.status!=='suspended'});
  const capabilities = useQuery({queryKey:['capabilities','onboarding',id],queryFn:()=>listCapabilities(),enabled:active && can('workspace.read')});
  const team = useQuery({queryKey:['team','onboarding',id],queryFn:listTeam,enabled:active && can('team.manage')});
  const keys = useQuery({queryKey:['api-keys','onboarding',id],queryFn:listKeys,enabled:active && can('api_keys.manage')});
  // Suspension is known only once the workspace has loaded; until then nothing is "not checked".
  const suspended = workspace.data?.status === 'suspended';
  const readable = !!workspace.data && !suspended;
  const approved = readable && pending.data && typeof pending.data.strategy === 'object' && 'approved' in pending.data.strategy;
  const recent = readable && pending.data?.agent.last_seen_at && !pending.data.agent.overdue;
  return <>
    <PageHeader title={t('onboarding.title')} description={t('onboarding.description')}/>
    <QueryState query={workspace}>
    <div className="grid min-w-0 gap-10 border-t border-border lg:grid-cols-[minmax(0,1fr)_260px]">
      <ol className="min-w-0">
        <SetupStep number={1} title={t('billing.title')}>
          <QueryState query={billing}>{billing.data && <>
            <p className="font-medium">{t(`billing.stages.${billingStage(billing.data)}`)}</p>
            <p className="text-muted-foreground">{t(billing.data.entitlement?.source==='grandfathered' && !billing.data.entitlement.revoked_at ? 'billing.grandfathered' : billing.data.payment?.confirmed?'onboarding.paymentConfirmed':'onboarding.paymentPending')}</p>
            {billing.data.entitlement?.revoked_at && <p>{t('billing.revoked')}</p>}
            <Button asChild variant="outline" size="sm"><Link to="/billing">{t('billing.title')}</Link></Button>
          </>}</QueryState>
        </SetupStep>
        <SetupStep number={2} title={t('onboarding.strategy')}>
          {readable && pending.data && <p className="text-muted-foreground">{t(approved?'onboarding.strategyApproved':'onboarding.strategyPending')}</p>}
          {readable && <QueryState query={pending}/>}
          {suspended && <p>{t('onboarding.suspendedChecks')}</p>}
          {workspace.data?.status!=='suspended' && <Link className="inline-block text-primary underline underline-offset-4" to="/strategy">{t('onboarding.prepare')}</Link>}
        </SetupStep>
        <SetupStep number={3} title={t('onboarding.teamKeys')}>
          {!active && <Callout tone="info">{t('onboarding.activationRequired')}</Callout>}
          {active && !can('team.manage') && !can('api_keys.manage') && <p className="text-muted-foreground">{t('onboarding.teamOwnerHelp')}</p>}
          {active && can('team.manage') && <><QueryState query={team}/>{team.data && <p>{t('onboarding.members',{count:team.data.length})}</p>}<Link className="inline-block text-primary underline underline-offset-4" to="/team">{t('onboarding.invite')}</Link></>}
          {active && can('api_keys.manage') && <><QueryState query={keys}/>{keys.data && <p>{t('onboarding.keys',{count:keys.data.filter(key=>key.status==='active').length})}</p>}<Link className="block text-primary underline underline-offset-4" to="/api-keys">{t('onboarding.createKey')}</Link></>}
        </SetupStep>
        <SetupStep number={4} title={t('onboarding.connector')}>
          {workspace.data && !active && <p className="text-muted-foreground">{t('onboarding.connectorAfterActivation')}</p>}
          {active && <QueryState query={capabilities}/>}
          {active && capabilities.data && <p>{t(capabilities.data.some(out=>out.effective_status==='verified' && out.capability.has_sealed_config)?'onboarding.connectorVerified':'onboarding.connectorPending')}</p>}
          {active && can('capabilities.manage') && <Link className="inline-block text-primary underline underline-offset-4" to="/connect">{t('onboarding.connect')}</Link>}
          {active && <Link className="block text-primary underline underline-offset-4" to="/capabilities">{t('onboarding.verify')}</Link>}
        </SetupStep>
        <SetupStep number={5} title={t('onboarding.agent')}>
          {suspended ? <Callout tone="info">{t('onboarding.suspendedChecks')}</Callout> : <QueryState query={pending}>
            {pending.data && <Callout tone={recent?'success':'warning'}>{t(recent?'onboarding.agentRecent':'onboarding.agentNeeded')}</Callout>}
          </QueryState>}
          {active && <Link className="inline-block text-primary underline underline-offset-4" to="/agents">{t('onboarding.agents')}</Link>}
        </SetupStep>
      </ol>
      <aside aria-hidden="true" className="hidden items-start justify-center pt-12 lg:flex">
        <img src="/brand/jeeta-guide.webp" alt="" width="520" height="520" className="sticky top-10 h-auto w-full" loading="lazy" decoding="async" />
      </aside>
    </div>
    </QueryState>
  </>;
}
