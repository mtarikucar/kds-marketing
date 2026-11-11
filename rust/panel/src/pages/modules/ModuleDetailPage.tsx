import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bot, Check, Download, Lock, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { listAgents } from '@/api/agents';
import { listCapabilities } from '@/api/capabilities';
import { installModule, removeModule, updateModule, type ModuleConfig, type WorkspaceModule } from '@/api/modules';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Button, Callout, ConfirmDialog, Input, PageHeader, Textarea, cn, toast } from '@/components/ui';
import { moduleMissing, modulePath, modulesKey, portableBlueprint, useModules } from '@/lib/modules';
import { requirementLabel, requirementTerms } from '@/lib/requirements';
import { can, currentMembership } from '@/lib/roles';
import { FormField } from './FormField';
import { ActivationNotice } from './ActivationNotice';
import { useModuleCopy } from './copy';

function ModuleSettings({ module }: { module: WorkspaceModule }) {
  const copy = useModuleCopy();
  const session = useSession();
  const workspaceId = session.data?.current_workspace;
  const workspaceActive = currentMembership(session.data)?.workspace_status === 'active';
  const canManage = workspaceActive && can(session.data, 'capabilities.manage');
  const agents = useQuery({ queryKey: ['agents', workspaceId], queryFn: listAgents, enabled: !!workspaceId && workspaceActive });
  const capabilities = useQuery({ queryKey: ['module-capabilities', workspaceId], queryFn: () => listCapabilities(), enabled: !!workspaceId && workspaceActive });
  const [config, setConfig] = useState<ModuleConfig>(() => structuredClone(module.config));
  const [revision, setRevision] = useState(module.revision);
  const [agentSearch, setAgentSearch] = useState('');
  const [capabilitySearch, setCapabilitySearch] = useState('');
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: ({ value, revision }: { value: ModuleConfig; revision: number; workspaceId: typeof workspaceId }) => updateModule(module.blueprint.id, value, revision),
    onSuccess: async (result, variables) => { const saved = result.modules.find(item => item.blueprint.id === module.blueprint.id); if (saved) { setConfig(structuredClone(saved.config)); setRevision(saved.revision); } await client.invalidateQueries({ queryKey: modulesKey(variables.workspaceId) }); toast.success(copy('saved')); },
  });
  const toggle = (key: 'agent_ids' | 'capability_ids', id: string) => setConfig(old => ({ ...old, [key]: old[key].includes(id) ? old[key].filter(value => value !== id) : [...old[key], id] }));
  const submit = (event: FormEvent) => { event.preventDefault(); if (canManage) save.mutate({ value: config, revision, workspaceId }); };
  const activeCapabilities = capabilities.data?.filter(item => item.effective_status !== 'retired') ?? [];
  const shownAgents = agents.data?.filter(agent => `${agent.client_name} ${agent.api_key_name}`.toLocaleLowerCase().includes(agentSearch.trim().toLocaleLowerCase()));
  const shownCapabilities = activeCapabilities.filter(item => `${item.capability.name} ${item.capability.key_detail ?? item.capability.kind_key}`.toLocaleLowerCase().includes(capabilitySearch.trim().toLocaleLowerCase()));
  // Keep missing/revoked selections visible so people can explicitly remove them, never silently drop.
  const missingAgents = agents.data ? config.agent_ids.filter(id => !agents.data.some(agent => agent.id === id)) : [];
  const missingCapabilities = capabilities.data ? config.capability_ids.filter(id => !activeCapabilities.some(item => item.capability.id === id)) : [];
  if (!workspaceActive) return null;
  return <form onSubmit={submit} className="flex min-w-0 flex-col gap-6 [overflow-wrap:anywhere]">
    {!canManage && <Callout tone="info">{copy('readOnly')}</Callout>}
    <FormField label={copy('brief')} htmlFor="module-brief" hint={copy('briefHint')}><Textarea id="module-brief" value={config.brief} onChange={event => setConfig(old => ({ ...old, brief: event.target.value }))} maxLength={8000} rows={4} disabled={!canManage || save.isPending} /></FormField>
    <section aria-labelledby="module-agents"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 id="module-agents" className="text-base font-medium">{copy('assignedAgents')}</h2><Button asChild variant="ghost" size="sm"><Link to="/agents">{copy('agentsManage')}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button></div><p className="mb-4 text-sm text-muted-foreground">{copy('assignedAgentsHint')}</p>
      <QueryState query={agents}>{agents.data && agents.data.length > 8 && <Input className="mb-3" aria-label={copy('searchAgents')} placeholder={copy('searchAgents')} value={agentSearch} onChange={event => setAgentSearch(event.target.value)} />}<div className="grid max-h-80 gap-2 overflow-y-auto p-1 sm:grid-cols-2">
        {shownAgents?.map(agent => <label key={agent.id} className="flex min-w-0 cursor-pointer items-center gap-3 rounded-md border border-border bg-surface p-4"><input type="checkbox" checked={config.agent_ids.includes(agent.id)} onChange={() => toggle('agent_ids', agent.id)} disabled={!canManage || save.isPending} className="h-4 w-4 shrink-0 accent-primary" /><Bot className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{agent.client_name}</span><span className="block truncate text-xs text-muted-foreground">{agent.api_key_name}</span></span></label>)}
        {agents.data?.length === 0 && <p className="text-sm text-muted-foreground">{copy('noAssigned')}</p>}
        {missingAgents.map(id => <label key={id} className="flex min-w-0 items-center gap-3 rounded-md border border-border p-4 text-sm text-muted-foreground"><input type="checkbox" checked onChange={() => toggle('agent_ids', id)} disabled={!canManage || save.isPending} /><span className="break-all">{id}</span></label>)}
      </div></QueryState>
    </section>
    <section aria-labelledby="module-capabilities"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 id="module-capabilities" className="text-base font-medium">{copy('bindings')}</h2><Button asChild variant="ghost" size="sm"><Link to="/capabilities">{copy('capabilitiesManage')}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button></div><p className="mb-4 text-sm text-muted-foreground">{copy('bindingsHint')}</p>
      <QueryState query={capabilities}>{activeCapabilities.length > 8 && <Input className="mb-3" aria-label={copy('searchCapabilities')} placeholder={copy('searchCapabilities')} value={capabilitySearch} onChange={event => setCapabilitySearch(event.target.value)} />}<div className="grid max-h-80 gap-2 overflow-y-auto p-1 sm:grid-cols-2">{shownCapabilities.map(item => <label key={item.capability.id} className="flex min-w-0 cursor-pointer items-center gap-3 rounded-md border border-border bg-surface p-4"><input type="checkbox" checked={config.capability_ids.includes(item.capability.id)} onChange={() => toggle('capability_ids', item.capability.id)} disabled={!canManage || save.isPending} className="h-4 w-4 shrink-0 accent-primary" /><SlidersHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="min-w-0"><span className="block truncate text-sm font-medium">{item.capability.name}</span><span className="block truncate text-xs text-muted-foreground">{item.capability.key_detail ?? item.capability.kind_key}</span></span></label>)}
        {activeCapabilities.length === 0 && <p className="text-sm text-muted-foreground">{copy('noCapabilities')}</p>}
        {missingCapabilities.map(id => <label key={id} className="flex min-w-0 items-center gap-3 rounded-md border border-border p-4 text-sm text-muted-foreground"><input type="checkbox" checked onChange={() => toggle('capability_ids', id)} disabled={!canManage || save.isPending} /><span className="break-all">{id}</span></label>)}
      </div></QueryState>
    </section>
    <p className="max-w-3xl text-xs leading-5 text-muted-foreground">{copy('selectionNote')}</p><ErrorCallout error={save.error} />
    {canManage && <div className="flex justify-end border-t border-border pt-4"><Button type="submit" loading={save.isPending} disabled={agents.isLoading || capabilities.isLoading || agents.isError || capabilities.isError}>{copy('save')}</Button></div>}
  </form>;
}

function InstalledModule({ module }: { module: WorkspaceModule }) {
  const { t, i18n } = useTranslation();
  const tr = i18n.language.startsWith('tr');
  const missing = moduleMissing(useModules().data, module.blueprint.id);
  const copy = useModuleCopy();
  const session = useSession();
  const workspaceId = session.data?.current_workspace;
  const workspaceActive = currentMembership(session.data)?.workspace_status === 'active';
  const canManage = workspaceActive && can(session.data, 'capabilities.manage');
  const [tab, setTab] = useState<'summary' | 'setup'>('summary');
  const [removing, setRemoving] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const remove = useMutation({ mutationFn: ({ id }: { id: string; workspaceId: typeof workspaceId }) => removeModule(id), onSuccess: async (_, variables) => { await client.invalidateQueries({ queryKey: modulesKey(variables.workspaceId) }); if (mounted.current) { toast.success(copy('removed')); navigate('/modules'); } } });
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(portableBlueprint(module.blueprint), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${module.blueprint.id}.blueprint.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const nativePath = modulePath(module);
  const native = !nativePath.startsWith('/modules/');
  return <>
    <PageHeader breadcrumbs={[{ label: copy('catalog'), href: '/modules' }]} renderBreadcrumbLink={(item, children) => <Link to={item.href!}>{children}</Link>} title={module.blueprint.name} description={module.blueprint.description} actions={native && <Button asChild size="sm"><Link to={nativePath}>{copy('builtInOpen')}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button>} />
    {!workspaceActive && <ActivationNotice />}
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"><span>{module.required ? copy('required') : copy('optional')}</span><span>{module.config.agent_ids.length} {copy('agentCount')}</span><span>{module.config.capability_ids.length} {copy('capabilityCount')}</span><span>v{module.blueprint.version}</span></div>
    <div role="group" aria-label={copy('chooseTab')} className="flex gap-5 border-b border-border">{(['summary', 'setup'] as const).map(value => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)} className={cn('min-h-12 border-b-2 px-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', tab === value ? 'border-primary font-medium' : 'border-transparent text-muted-foreground')}>{copy(value)}</button>)}</div>
    {tab === 'summary' ? <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="flex min-w-0 flex-col gap-6 [overflow-wrap:anywhere]">
        {module.config.brief && <section><h2 className="mb-3 text-base font-medium">{copy('storedInstructions')}</h2><p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{module.config.brief}</p></section>}
        <section><h2 className="mb-4 text-base font-medium">{copy('steps')}</h2>{module.blueprint.workflow.length ? <ol className="divide-y divide-border">{module.blueprint.workflow.map((step, index) => <li key={index} className="flex gap-4 py-4"><span className="w-6 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><p className="min-w-0 break-words text-sm leading-6 [overflow-wrap:anywhere]">{step}</p></li>)}</ol> : <p className="text-sm text-muted-foreground">{copy('emptyWorkflow')}</p>}</section>
        <Button variant="outline" size="sm" className="self-start" onClick={() => setTab('setup')}><SlidersHorizontal className="h-4 w-4" aria-hidden="true" />{copy('configure')}</Button>
      </div>
      <aside className="flex min-w-0 flex-col gap-6 border-t border-border pt-6 lg:border-s lg:border-t-0 lg:ps-6 lg:pt-0"><section><h2 className="mb-3 text-sm font-medium">{copy('requirements')}</h2>{module.blueprint.requirements.length ? <ul className="space-y-3">{module.blueprint.requirements.map((requirement, index) => {
        const gating = requirementTerms(requirement) !== null;
        const unmet = missing.includes(requirement.split('|').map(term => term.trim()).join('|'));
        return <li key={index} className={cn('flex items-start gap-2 break-words border-s-2 ps-3 text-sm', !gating ? 'border-border text-muted-foreground' : unmet ? 'border-warning text-foreground' : 'border-success text-foreground')}>
          {gating && (unmet ? <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-label={tr ? 'Bağlı değil' : 'Not connected'} /> : <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-label={tr ? 'Bağlı' : 'Connected'} />)}
          <span>{requirementLabel(t, requirement, tr ? 'veya' : 'or')}</span>
        </li>;
      })}</ul> : <p className="text-sm text-muted-foreground">{copy('requirementsEmpty')}</p>}</section><p className="text-xs leading-5 text-muted-foreground">{copy('blueprintNote')}</p><Button type="button" variant="ghost" size="sm" className="self-start" onClick={download}><Download className="h-4 w-4" aria-hidden="true" />{copy('export')}</Button></aside>
    </div> : <ModuleSettings key={module.blueprint.id} module={module} />}
    {!module.required && canManage && <div className="mt-2 border-t border-border pt-4"><Button variant="ghost" size="sm" onClick={() => setRemoving(true)}><Trash2 className="h-4 w-4" aria-hidden="true" />{copy('remove')}</Button><ErrorCallout error={remove.error} /></div>}
    <ConfirmDialog open={removing && canManage} onOpenChange={setRemoving} title={copy('removeTitle')} description={copy('removeBody')} confirmLabel={copy('remove')} loading={remove.isPending} onConfirm={() => { if (canManage) remove.mutate({ id: module.blueprint.id, workspaceId }); }} />
  </>;
}

export function ModuleDetailPage() {
  const { moduleId } = useParams();
  const copy = useModuleCopy();
  const registry = useModules();
  const session = useSession();
  const workspaceId = session.data?.current_workspace;
  const client = useQueryClient();
  const module = registry.data?.modules.find(item => item.blueprint.id === moduleId && item.installed);
  const blueprint = registry.data?.catalog.find(item => item.id === moduleId);
  const install = useMutation({ mutationFn: ({ id }: { id: string; workspaceId: typeof workspaceId }) => installModule(id), onSuccess: async (_, variables) => { await client.invalidateQueries({ queryKey: modulesKey(variables.workspaceId) }); } });
  return <div className="flex min-w-0 flex-col gap-6 [overflow-wrap:anywhere]">
    <QueryState query={registry}>{module ? <InstalledModule key={module.blueprint.id} module={module} /> : registry.data && <><PageHeader breadcrumbs={[{ label: copy('catalog'), href: '/modules' }]} renderBreadcrumbLink={(item, children) => <Link to={item.href!}>{children}</Link>} title={blueprint?.name ?? copy('noModule')} description={blueprint?.description ?? copy('noModuleBody')} /><ErrorCallout error={install.error} />{currentMembership(session.data)?.workspace_status !== 'active' && <ActivationNotice />}{blueprint && currentMembership(session.data)?.workspace_status === 'active' && can(session.data, 'capabilities.manage') && <Button className="self-start" loading={install.isPending} onClick={() => install.mutate({ id: blueprint.id, workspaceId })}><Plus className="h-4 w-4" aria-hidden="true" />{copy('install')}</Button>}</>}</QueryState>
  </div>;
}
