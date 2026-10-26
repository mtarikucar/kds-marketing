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
import { Button, Callout, Card, CardContent, PageHeader } from '@/components/ui';
import { billingStage, useBilling } from './billing/queries';

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
  const readable = !!workspace.data && workspace.data.status !== 'suspended';
  const approved = readable && pending.data && typeof pending.data.strategy === 'object' && 'approved' in pending.data.strategy;
  const recent = readable && pending.data?.agent.last_seen_at && !pending.data.agent.overdue;
  return <>
    <PageHeader title={t('onboarding.title')} description={t('onboarding.description')}/>
    <QueryState query={workspace}/>
    <QueryState query={billing}>{billing.data && <Card><CardContent className="space-y-4 pt-6">
      <h2 className="text-h3">{t(`billing.stages.${billingStage(billing.data)}`)}</h2>
      <p>{t(billing.data.entitlement?.source==='grandfathered' && !billing.data.entitlement.revoked_at ? 'billing.grandfathered' : billing.data.payment?.confirmed?'onboarding.paymentConfirmed':'onboarding.paymentPending')}</p>
      {billing.data.entitlement?.revoked_at && <p>{t('billing.revoked')}</p>}
      <Button asChild><Link to="/billing">{t('billing.title')}</Link></Button>
    </CardContent></Card>}</QueryState>
    <Card><CardContent className="space-y-4 pt-6">
      <h2 className="text-h3">{t('onboarding.strategy')}</h2>
      {readable && pending.data && <p>{t(approved?'onboarding.strategyApproved':'onboarding.strategyPending')}</p>}
      {readable ? <QueryState query={pending}/> : <p>{t('onboarding.suspendedChecks')}</p>}
      {workspace.data?.status!=='suspended' && <Link className="text-primary underline" to="/strategy">{t('onboarding.prepare')}</Link>}
    </CardContent></Card>
    <Card><CardContent className="space-y-4 pt-6">
      <h2 className="text-h3">{t('onboarding.teamKeys')}</h2>
      {!active && <Callout tone="info">{t('onboarding.activationRequired')}</Callout>}
      {active && can('team.manage') && <><QueryState query={team}/>{team.data && <p>{t('onboarding.members',{count:team.data.length})}</p>}<Link className="text-primary underline" to="/team">{t('onboarding.invite')}</Link></>}
      {active && can('api_keys.manage') && <><QueryState query={keys}/>{keys.data && <p>{t('onboarding.keys',{count:keys.data.filter(key=>key.status==='active').length})}</p>}<Link className="block text-primary underline" to="/api-keys">{t('onboarding.createKey')}</Link></>}
    </CardContent></Card>
    <Card><CardContent className="space-y-4 pt-6">
      <h2 className="text-h3">{t('onboarding.connector')}</h2>
      {active && <QueryState query={capabilities}/>}
      {active && capabilities.data && <p>{t(capabilities.data.some(out=>out.effective_status==='verified' && out.capability.has_sealed_config)?'onboarding.connectorVerified':'onboarding.connectorPending')}</p>}
      {active && can('capabilities.manage') && <Link className="text-primary underline" to="/connect">{t('onboarding.connect')}</Link>}
      {active && <Link className="block text-primary underline" to="/capabilities">{t('onboarding.verify')}</Link>}
    </CardContent></Card>
    <Card><CardContent className="space-y-4 pt-6">
      <h2 className="text-h3">{t('onboarding.agent')}</h2>
      <Callout tone={recent?'success':'warning'}>{t(!readable?'onboarding.suspendedChecks':recent?'onboarding.agentRecent':'onboarding.agentNeeded')}</Callout>
      {active && <Link className="text-primary underline" to="/agents">{t('onboarding.agents')}</Link>}
    </CardContent></Card>
  </>;
}
