import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
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
import { useEntryCopy } from './entryCopy';

function SetupStep({ number, title, children, current, optional }: { number: number; title: string; children: ReactNode; current: boolean; optional?: string }) {
  return <li className="border-b border-border py-5 last:border-b-0"><details open={current} className="group">
    <summary className="flex cursor-pointer list-none items-center gap-4 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-6 [&::-webkit-details-marker]:hidden">
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-sm font-medium text-foreground">{number}</span>
      <h2 className="min-w-0 flex-1 text-base font-medium text-foreground">{title}</h2>
      {optional && <span className="text-xs text-muted-foreground">{optional}</span>}
      <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"/>
    </summary>
    <div className="min-w-0 space-y-3 ps-12 pt-4 text-sm leading-6 sm:ps-14">
      {children}
    </div></details>
  </li>;
}

export function OnboardingPage() {
  const { t } = useTranslation();
  const copy = useEntryCopy();
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
  const connected = capabilities.data?.some(out=>out.effective_status==='verified' && out.capability.has_sealed_config);
  const nextQuery = !active ? billing : !pending.isSuccess ? pending : approved ? capabilities : pending;
  const nextReady = !suspended && nextQuery.isSuccess && (!active || can('workspace.read'));
  const next = !nextReady ? null : !active ? 1 : !approved ? 2 : !connected ? 4 : !recent ? 5 : 0;
  const nextHref = next===1?'/billing':next===2?'/strategy':next===4?(can('capabilities.manage')?'/connect':'/capabilities'):next===5?'/agents':'/';
  return <>
    <PageHeader title={t('onboarding.title')} description={t('onboarding.description')}/>
    <QueryState query={workspace}>
    <div className="max-w-3xl space-y-6">
      <section className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4 sm:gap-6 sm:p-6" aria-label={copy('setupNextTitle')}>
        <img src="/brand/guide-setup.webp" alt="" width="480" height="480" className="h-28 w-28 shrink-0 object-contain"/>
        <div className="min-w-0 space-y-2"><p className="text-xs text-muted-foreground">{copy('setupNextTitle')}</p>
          {suspended ? <><h2 className="text-base font-medium">{copy('setupSuspended')}</h2><p className="text-sm text-muted-foreground">{t('onboarding.suspendedChecks')}</p></> : active && !can('workspace.read') ? <p className="text-sm text-muted-foreground">{copy('setupPermission')}</p> : <QueryState query={nextQuery}>{next!==null && <><h2 className="text-base font-medium">{copy(next===1?'setupNextPayment':next===2?'setupNextStrategy':next===4?'setupNextConnection':next===5?'setupNextAgent':'setupDone')}</h2><Button asChild variant="outline" size="sm"><Link to={nextHref}>{copy('setupOpen')}</Link></Button></>}</QueryState>}
        </div>
      </section>
      <ol className="min-w-0 border-t border-border">
        <SetupStep number={1} title={t('billing.title')} current={next===1}>
          <QueryState query={billing}>{billing.data && <>
            <p className="font-medium">{t(`billing.stages.${billingStage(billing.data)}`)}</p>
            <p className="text-muted-foreground">{t(billing.data.entitlement?.source==='grandfathered' && !billing.data.entitlement.revoked_at ? 'billing.grandfathered' : billing.data.payment?.confirmed?'onboarding.paymentConfirmed':'onboarding.paymentPending')}</p>
            {billing.data.entitlement?.revoked_at && <p>{t('billing.revoked')}</p>}
            <Button asChild variant="outline" size="sm"><Link to="/billing">{t('billing.title')}</Link></Button>
          </>}</QueryState>
        </SetupStep>
        <SetupStep number={2} title={t('onboarding.strategy')} current={next===2}>
          {readable && pending.data && <p className="text-muted-foreground">{t(approved?'onboarding.strategyApproved':'onboarding.strategyPending')}</p>}
          {readable && <QueryState query={pending}/>}
          {suspended && <p>{t('onboarding.suspendedChecks')}</p>}
          {workspace.data?.status!=='suspended' && <Link className="inline-block text-primary underline underline-offset-4" to="/strategy">{t('onboarding.prepare')}</Link>}
        </SetupStep>
        <SetupStep number={3} title={t('onboarding.teamKeys')} current={false} optional={copy('setupOptional')}>
          {!active && <Callout tone="info">{t('onboarding.activationRequired')}</Callout>}
          {active && !can('team.manage') && !can('api_keys.manage') && <p className="text-muted-foreground">{t('onboarding.teamOwnerHelp')}</p>}
          {active && can('team.manage') && <><QueryState query={team}/>{team.data && <p>{t('onboarding.members',{count:team.data.length})}</p>}<Link className="inline-block text-primary underline underline-offset-4" to="/users">{t('onboarding.invite')}</Link></>}
          {active && can('api_keys.manage') && <><QueryState query={keys}/>{keys.data && <p>{t('onboarding.keys',{count:keys.data.filter(key=>key.status==='active').length})}</p>}<Link className="block text-primary underline underline-offset-4" to="/api-keys">{t('onboarding.createKey')}</Link></>}
        </SetupStep>
        <SetupStep number={4} title={t('onboarding.connector')} current={next===4}>
          {workspace.data && !active && <p className="text-muted-foreground">{t('onboarding.connectorAfterActivation')}</p>}
          {active && <QueryState query={capabilities}/>}
          {active && capabilities.data && <p>{t(capabilities.data.some(out=>out.effective_status==='verified' && out.capability.has_sealed_config)?'onboarding.connectorVerified':'onboarding.connectorPending')}</p>}
          {active && can('capabilities.manage') && <Link className="inline-block text-primary underline underline-offset-4" to="/connect">{t('onboarding.connect')}</Link>}
          {active && <Link className="block text-primary underline underline-offset-4" to="/capabilities">{t('onboarding.verify')}</Link>}
        </SetupStep>
        <SetupStep number={5} title={t('onboarding.agent')} current={next===5}>
          {suspended ? <Callout tone="info">{t('onboarding.suspendedChecks')}</Callout> : <QueryState query={pending}>
            {pending.data && <Callout tone={recent?'success':'warning'}>{t(recent?'onboarding.agentRecent':'onboarding.agentNeeded')}</Callout>}
          </QueryState>}
          {active && <Link className="inline-block text-primary underline underline-offset-4" to="/agents">{t('onboarding.agents')}</Link>}
        </SetupStep>
      </ol>
    </div>
    </QueryState>
  </>;
}
