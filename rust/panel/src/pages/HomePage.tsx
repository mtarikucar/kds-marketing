import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Bot, ChevronRight, Compass, Inbox, Layers, Plus, SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { listAgents } from '@/api/agents';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { Button, cn, PageHeader } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { modulePath, moduleSettingsPath, moduleVisibleTo, useModules } from '@/lib/modules';
import { can, currentMembership } from '@/lib/roles';
import { useModuleCopy } from './modules/copy';
import { ActivationNotice } from './modules/ActivationNotice';

/** The center is a view of recorded connections and explicit assignments, never an online claim. */
export function HomePage() {
  const copy = useModuleCopy();
  const { i18n } = useTranslation();
  const session = useSession();
  const workspaceId = session.data?.current_workspace;
  const workspaceActive = currentMembership(session.data)?.workspace_status === 'active';
  const agents = useQuery({ queryKey: ['agents', workspaceId], queryFn: listAgents, enabled: !!workspaceId && workspaceActive });
  const registry = useModules();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [allModules, setAllModules] = useState(false);
  const installed = registry.data?.modules.filter(module => module.installed && moduleVisibleTo(module, session.data)) ?? [];
  const optional = installed.filter(module => !module.required);
  const selected = workspaceActive ? agents.data?.find(agent => agent.id === selectedAgent) : undefined;
  const shown = selected ? installed.filter(module => module.config.agent_ids.includes(selected.id)) : optional;
  const canManage = workspaceActive && can(session.data, 'capabilities.manage');

  return <div className="flex min-w-0 flex-col gap-8 [overflow-wrap:anywhere]">
    <PageHeader title={copy('center')} description={copy('centerBody')}
      actions={<Button asChild size="sm" variant="outline"><Link to="/activity">{copy('operations')}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>} />

    <section aria-labelledby="center-agents" className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3"><Bot className="h-5 w-5 text-muted-foreground" aria-hidden="true" /><h2 id="center-agents" className="text-base font-medium">{copy('connectedAgents')}</h2>
          {workspaceActive && agents.data && <span className="text-xs tabular-nums text-muted-foreground">{agents.data.length}</span>}
        </div>
        {workspaceActive && <Button asChild variant="ghost" size="sm"><Link to={can(session.data, 'api_keys.manage') ? '/api-keys' : '/agents'}>{can(session.data, 'api_keys.manage') ? copy('agentConnect') : copy('agentsManage')}<Plus className="h-4 w-4" aria-hidden="true" /></Link></Button>}
      </div>
      {!workspaceActive ? <div className="p-5 sm:p-6"><ActivationNotice /></div> : <QueryState query={agents}>
        {agents.data?.length === 0 ? <div className="grid gap-6 p-6 sm:grid-cols-[minmax(0,1fr)_160px] sm:items-center sm:p-8">
          <div><h3 className="text-xl font-normal">{copy('noAgents')}</h3><p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{copy('noAgentsBody')}</p></div>
          <svg className="hidden h-28 w-40 text-muted-foreground sm:block" viewBox="0 0 160 112" fill="none" aria-hidden="true"><path d="M24 56H56M104 56h32M80 32V16M80 80v16" stroke="currentColor" strokeOpacity=".4"/><rect x="56" y="32" width="48" height="48" rx="10" fill="currentColor" fillOpacity=".04" stroke="currentColor" strokeOpacity=".4"/><path d="M72 50v12m16-12v12M72 68h16" stroke="currentColor" strokeWidth="2"/><circle cx="24" cy="56" r="7" stroke="currentColor" strokeOpacity=".4"/><circle cx="136" cy="56" r="7" stroke="currentColor" strokeOpacity=".4"/><circle cx="80" cy="12" r="4" fill="currentColor" fillOpacity=".4"/><circle cx="80" cy="100" r="4" fill="currentColor" fillOpacity=".4"/></svg>
        </div> : <div className={cn("grid gap-px bg-surface", (agents.data?.length ?? 0) > 1 && "sm:grid-cols-2", (agents.data?.length ?? 0) > 2 && "xl:grid-cols-3")}>
          {agents.data?.slice(0, 6).map(agent => {
            const assigned = installed.filter(module => module.config.agent_ids.includes(agent.id));
            return <button type="button" key={agent.id} aria-pressed={selectedAgent === agent.id} onClick={() => setSelectedAgent(selectedAgent === agent.id ? null : agent.id)}
              className={cn('flex min-w-0 flex-col items-start gap-4 border-b-2 bg-surface p-5 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-6', selectedAgent === agent.id ? 'border-primary bg-surface-muted' : 'border-transparent hover:bg-surface-muted/50')}>
              <span className="flex w-full min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background font-mono text-sm">{agent.client_name.slice(0, 2).toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate font-medium">{agent.client_name}</span><span className="block truncate text-xs text-muted-foreground">{agent.api_key_name}</span></span><ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /></span>
              <span className="text-xs text-muted-foreground">{copy('lastContact')} · {formatRelative(agent.last_seen_at, i18n.language)}</span>
              <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{assigned.length ? assigned.slice(0, 3).map(module => <span key={module.blueprint.id}>{module.blueprint.name}</span>) : copy('emptyAssigned')}{assigned.length > 3 && <span>+{assigned.length - 3}</span>}</span>
            </button>;
          })}
        </div>}
      </QueryState>}
      {workspaceActive && agents.data && agents.data.length > 6 && <div className="border-t border-border px-5 py-3"><Button asChild size="sm" variant="ghost"><Link to="/agents">{copy('allConnections')} ({agents.data.length})<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button></div>}
    </section>

    <section aria-labelledby="center-modules" className="relative">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3"><h2 id="center-modules" className="text-lg font-medium">{selected ? copy('agentModules') : copy('modules')}</h2>{selected && <Button size="sm" variant="ghost" onClick={() => setSelectedAgent(null)}>{copy('allAgents')}</Button>}</div>
        <Button asChild size="sm" variant="outline"><Link to="/modules"><Plus className="h-4 w-4" aria-hidden="true" />{canManage ? copy('add') : copy('moduleLibrary')}</Link></Button>
      </div>
      <QueryState query={registry}>
        {shown.length === 0 ? <div className="flex flex-col items-start gap-3 border-s-2 border-border py-3 ps-5"><p className="font-medium">{selected ? copy('emptyAssigned') : copy('emptyModules')}</p><p className="max-w-xl text-sm leading-6 text-muted-foreground">{selected ? copy('emptyAssignedBody') : copy('emptyModulesBody')}</p></div>
          : <div className="grid gap-4 lg:grid-cols-2">
            {(allModules ? shown : shown.slice(0, 6)).map(module => <article key={module.blueprint.id} className="flex min-w-0 flex-col rounded-lg border border-border bg-surface p-5">
              <div className="flex items-start gap-4"><div className="min-w-0 flex-1"><h3 className="break-words text-lg font-medium"><Link className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" to={modulePath(module)}>{module.blueprint.name}</Link></h3><p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{module.blueprint.description}</p></div><Layers className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" /></div>
              <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4"><span className="me-auto text-xs text-muted-foreground">{module.config.agent_ids.length} {copy('agentCount')} · {module.config.capability_ids.length} {copy('capabilityCount')}</span><Button asChild variant="ghost" size="sm"><Link to={moduleSettingsPath(module.blueprint.id)}><SlidersHorizontal className="h-4 w-4" aria-hidden="true" /><span className="sr-only">{module.blueprint.name} </span>{copy('configure')}</Link></Button><Button asChild size="sm" variant="outline"><Link to={modulePath(module)}>{copy('open')}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button></div>
            </article>)}
          </div>}
      </QueryState>
      {shown.length > 6 && <Button variant="ghost" size="sm" className="mt-4" onClick={() => setAllModules(value => !value)}>{copy(allModules ? 'less' : 'more')} ({shown.length})</Button>}
    </section>

    <section aria-labelledby="center-foundation" className="border-t border-border pt-6">
      <div className="mb-4 flex flex-wrap items-center gap-3"><h2 id="center-foundation" className="text-sm font-medium">{copy('core')}</h2><span className="text-xs text-muted-foreground">{copy('required')}</span></div>
      <div className="grid gap-5 sm:grid-cols-2 ">
        {[{ to: '/inbox', title: copy('inbox'), body: copy('inboxBody'), Icon: Inbox }, { to: '/strategy', title: copy('strategy'), body: copy('strategyBody'), Icon: Compass }].map(({ to, title, body, Icon }) => <Link to={to} key={to} className="group flex min-w-0 items-start gap-3 rounded-md py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Icon className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium group-hover:underline">{title}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{body}</span></span><ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /></Link>)}
      </div>
    </section>
    <Link to="/capabilities" className="flex items-center gap-3 border-t border-border pt-4 text-sm text-muted-foreground hover:text-foreground"><SlidersHorizontal className="h-4 w-4" aria-hidden="true" /><span>{copy('capabilitiesManage')}</span><ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
  </div>;
}
