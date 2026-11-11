import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FileUp, Layers, Plus, Search } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { installModule, type Blueprint } from '@/api/modules';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, PageHeader, Textarea, cn } from '@/components/ui';
import { lines, modulePath, moduleSettingsPath, moduleVisibleTo, modulesKey, parseBlueprint, useModules } from '@/lib/modules';
import { can, currentMembership } from '@/lib/roles';
import { useModuleCopy } from './copy';
import { requirementLabel } from '@/lib/requirements';
import { useTranslation } from 'react-i18next';
import { FormField } from './FormField';
import { RequirementPicker } from './RequirementPicker';
import { ActivationNotice } from './ActivationNotice';

function BlueprintDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const copy = useModuleCopy();
  const workspaceId = useSession().data?.current_workspace;
  const client = useQueryClient();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [requirements, setRequirements] = useState<string[]>([]);
  const [version, setVersion] = useState('1.0.0');
  const [fileError, setFileError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const mutation = useMutation({
    mutationFn: ({ blueprint }: { blueprint: Blueprint; workspaceId: typeof workspaceId }) => installModule(blueprint.id, blueprint),
    onSuccess: async (_, variables) => {
      await client.invalidateQueries({ queryKey: modulesKey(variables.workspaceId) });
      if (mounted.current) { onClose(); navigate(moduleSettingsPath(variables.blueprint.id)); }
    },
  });
  const loadFile = async (selected: File) => {
    setFileError(null);
    if (selected.size > 65536) { setFileError(copy('importSize')); return; }
    try {
      const parsed = parseBlueprint(JSON.parse(await selected.text()));
      if (!parsed) throw new Error('invalid');
      setId(parsed.id); setIdEdited(true); setName(parsed.name); setDescription(parsed.description); setWorkflow(parsed.workflow.join('\n')); setRequirements(parsed.requirements); setVersion(parsed.version);
    } catch { setFileError(copy('invalidFile')); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const blueprint = parseBlueprint({ id, name, description, version, requirements, workflow: lines(workflow) });
    if (!blueprint) { setFileError(copy('invalidDefinition')); return; }
    setFileError(null); mutation.mutate({ blueprint, workspaceId });
  };
  return <Dialog open={open} onOpenChange={value => { if (!value && !mutation.isPending) onClose(); }}><DialogContent dismissible={!mutation.isPending} className="max-w-xl">
    <DialogHeader><DialogTitle>{copy('create')}</DialogTitle><DialogDescription>{copy('createBody')}</DialogDescription></DialogHeader>
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4"><Button type="button" variant="outline" size="sm" onClick={() => file.current?.click()}><FileUp className="h-4 w-4" aria-hidden="true" />{copy('import')}</Button><span className="max-w-xs text-xs leading-5 text-muted-foreground">{copy('importBody')}</span><input ref={file} type="file" accept="application/json,.json" className="sr-only" aria-label={copy('import')} onChange={event => { const selected = event.target.files?.[0]; if (selected) void loadFile(selected); event.target.value = ''; }} /></div>
      <FormField label={copy('name')} htmlFor="blueprint-name"><Input id="blueprint-name" value={name} onChange={event => { const name = event.target.value; setName(name); if (!idEdited) { const slug = name.toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64); setId(/^[a-z]/.test(slug) ? (slug.length > 1 ? slug : `${slug}-module`) : ''); } }} required maxLength={120} autoComplete="off" /></FormField>
      <FormField label={copy('id')} htmlFor="blueprint-id"><Input id="blueprint-id" value={id} onChange={event => { setIdEdited(true); setId(event.target.value); }} required pattern="[a-z][a-z0-9_-]{1,63}" maxLength={64} placeholder="my-workflow" autoComplete="off" className="font-mono" /></FormField>
      <FormField label={copy('description')} htmlFor="blueprint-description"><Textarea id="blueprint-description" value={description} onChange={event => setDescription(event.target.value)} maxLength={2000} rows={2} /></FormField>
      <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{copy('workflow')} · {copy('requirements')}</summary><div className="mt-4 flex flex-col gap-4">
        <FormField label={copy('workflow')} htmlFor="blueprint-workflow" hint={copy('workflowHint')}><Textarea id="blueprint-workflow" value={workflow} onChange={event => setWorkflow(event.target.value)} rows={3} maxLength={25000} /></FormField>
        <fieldset className="flex min-w-0 flex-col gap-2"><legend className="mb-1 text-sm font-medium">{copy('requirements')}</legend><RequirementPicker value={requirements} onChange={setRequirements} /></fieldset>
        <FormField label={copy('version')} htmlFor="blueprint-version"><Input id="blueprint-version" value={version} onChange={event => setVersion(event.target.value)} required maxLength={32} /></FormField>
      </div></details>
      {fileError && <p role="alert" className="text-sm text-danger">{fileError}</p>}<ErrorCallout error={mutation.error} />
      <DialogFooter><Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>{copy('cancel')}</Button><Button type="submit" loading={mutation.isPending}>{copy('createAndInstall')}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

export function ModulesPage() {
  const copy = useModuleCopy();
  const { t, i18n } = useTranslation();
  const tr = i18n.language.startsWith('tr');
  const session = useSession();
  const workspaceId = session.data?.current_workspace;
  const registry = useModules();
  const client = useQueryClient();
  const [tab, setTab] = useState<'available' | 'installed'>('available');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const workspaceActive = currentMembership(session.data)?.workspace_status === 'active';
  const manage = workspaceActive && can(session.data, 'capabilities.manage');
  const install = useMutation({ mutationFn: ({ id }: { id: string; workspaceId: typeof workspaceId }) => installModule(id), onSuccess: async (_, variables) => { await client.invalidateQueries({ queryKey: modulesKey(variables.workspaceId) }); } });
  const modules = registry.data?.modules ?? [];
  const catalog = registry.data?.catalog ?? [];
  const installed = modules.filter(module => module.installed);
  const candidates = (tab === 'installed' ? installed.map(module => module.blueprint) : catalog.filter(blueprint => !installed.some(module => module.blueprint.id === blueprint.id))).filter(blueprint => moduleVisibleTo(blueprint, session.data));
  const shown = candidates.filter(blueprint => `${blueprint.name} ${blueprint.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <div className="flex min-w-0 flex-col gap-6 [overflow-wrap:anywhere]">
    <PageHeader title={copy('catalog')} description={copy('catalogBody')} actions={manage && <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" aria-hidden="true" />{copy('create')}</Button>} />
    <div className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div role="group" aria-label={copy('chooseTab')} className="flex gap-1 rounded-lg bg-surface-muted p-1">{(['available', 'installed'] as const).map(value => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)} className={cn('min-h-10 rounded-md px-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', tab === value ? 'bg-surface font-medium shadow-xs' : 'text-muted-foreground')}>{copy(value)}{value === 'installed' && registry.data && <span className="ms-2 text-xs tabular-nums text-muted-foreground">{installed.length}</span>}</button>)}</div>
      <label className="relative w-full sm:max-w-xs"><Search className="absolute start-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" /><Input aria-label={copy('search')} placeholder={copy('search')} value={search} onChange={event => setSearch(event.target.value)} className="ps-9" /></label>
    </div>
    {!workspaceActive && <ActivationNotice />}
    <ErrorCallout error={install.error} />
    <QueryState query={registry}>
      {shown.length === 0 ? <p className="border-s-2 border-border py-5 ps-5 text-sm text-muted-foreground">{copy('noResults')}</p> : <div className="grid gap-4 lg:grid-cols-2">
        {shown.map(blueprint => {
          const current = installed.find(module => module.blueprint.id === blueprint.id);
          return <article key={blueprint.id} className="flex min-w-0 flex-col rounded-lg border border-border bg-surface p-4 sm:p-6">
            <div className="flex items-start gap-3"><Layers className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><h2 className="break-words text-base font-medium sm:text-lg">{blueprint.name}</h2><span className="text-xs text-muted-foreground">{current?.required ? copy('required') : blueprint.builtin ? copy('builtIn') : copy('custom')}</span></div>{blueprint.description && <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground sm:text-sm sm:leading-6">{blueprint.description}</p>}</div></div>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4"><span className="text-xs text-muted-foreground">{blueprint.requirements.length > 0 && blueprint.requirements.map(line => requirementLabel(t, line, tr ? 'veya' : 'or')).join(' · ')}</span>{current ? <div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="ghost"><Link to={moduleSettingsPath(blueprint.id)}>{copy('configure')}</Link></Button><Button asChild size="sm" variant="outline"><Link to={modulePath(current)}>{copy('open')}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></Button></div> : manage && <Button size="sm" variant="outline" loading={install.isPending && install.variables?.id === blueprint.id} disabled={install.isPending} onClick={() => install.mutate({ id: blueprint.id, workspaceId })}><Plus className="h-4 w-4" aria-hidden="true" />{copy('install')}</Button>}</div>
          </article>;
        })}
      </div>}
    </QueryState>
    <p className="max-w-3xl text-xs leading-5 text-muted-foreground">{copy('blueprintNote')}</p>
    {createOpen && manage && <BlueprintDialog open onClose={() => setCreateOpen(false)} />}
  </div>;
}
