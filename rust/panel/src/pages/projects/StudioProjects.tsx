import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Plus, FolderOpen } from 'lucide-react';
import * as api from '@/api/projects';
import { useSession } from '@/auth/useSession';
import { can } from '@/lib/roles';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useStudioKey } from '../StudioShared';
import {
  MaterialsReadStatus,
  fieldClass,
  primaryClass,
  tapClass,
  useMaterialsMutation,
} from '../materials/MaterialsShared';
import { EmptyNote, ProjectError, useRequestKey } from './ProjectShared';
import { ProjectMaterials } from './ProjectMaterials';
import { ProjectProduction } from './ProjectProduction';
import { ProjectRequests } from './ProjectRequests';
import { ProjectPublications } from './ProjectPublications';

function ProjectCreate({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const keyFor = useRequestKey();
  const create = useMaterialsMutation(
    () => {
      const input = { title: title.trim(), brief: brief.trim() };
      return api.projectCreate({ ...input, request_key: keyFor(input) });
    },
    (project) => onCreated(project.id),
  );
  return (
    <form
      className="max-w-2xl space-y-4 border-t-2 border-foreground bg-surface p-5 sm:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && !create.isPending) create.mutate(undefined);
      }}
    >
      <h3 className="text-lg font-medium">{t('projects.create')}</h3>
      <label className="block space-y-2 text-sm">
        <span>{t('projects.title')}</span>
        <input
          autoFocus
          required
          maxLength={160}
          className={fieldClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('projects.titlePlaceholder')}
        />
      </label>
      <label className="block space-y-2 text-sm">
        <span>{t('projects.brief')}</span>
        <textarea
          rows={3}
          maxLength={5000}
          className={fieldClass}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder={t('projects.briefPlaceholder')}
        />
      </label>
      <p className="text-sm leading-6 text-muted-foreground">{t('projects.createHint')}</p>
      <ProjectError error={create.error} />
      <div className="flex flex-wrap gap-2">
        <button className={primaryClass} disabled={!title.trim() || create.isPending}>
          {t('projects.create')}
        </button>
        <button type="button" className={tapClass} onClick={onCancel} disabled={create.isPending}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

function BriefEditor({ project, onClose }: { project: api.ProductionProject; onClose: () => void }) {
  const { t } = useTranslation();
  const [base] = useState(project.revision);
  const [title, setTitle] = useState(project.title);
  const [brief, setBrief] = useState(project.brief);
  const save = useMaterialsMutation(
    () =>
      api.projectUpdate(project.id, { expected_revision: base, title: title.trim(), brief: brief.trim() }),
    onClose,
  );
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!save.isPending && title.trim()) save.mutate(undefined);
      }}
    >
      <label className="block space-y-2 text-sm">
        <span>{t('projects.title')}</span>
        <input
          required
          maxLength={160}
          className={fieldClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="block space-y-2 text-sm">
        <span>{t('projects.brief')}</span>
        <textarea
          rows={4}
          maxLength={5000}
          className={fieldClass}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
      </label>
      <p className="text-sm leading-6 text-muted-foreground">{t('projects.briefChangesHelp')}</p>
      <ProjectError error={save.error} />
      <div className="flex flex-wrap gap-2">
        <button className={primaryClass} disabled={!title.trim() || save.isPending}>
          {t('common.save')}
        </button>
        <button type="button" className={tapClass} disabled={save.isPending} onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

export function StudioProjects({ onOpenSlot }: { onOpenSlot: (id: string) => void }) {
  const { t } = useTranslation();
  const key = [...useStudioKey(), 'projects'];
  const session = useSession();
  const manage = can(session.data, 'content.manage');
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project');
  const pane = ['materials', 'production', 'publications'].includes(params.get('projectView') ?? '')
    ? params.get('projectView')!
    : 'overview';
  const [creating, setCreating] = useState(false);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const open = (id?: string, view = 'overview') => {
    setEditing(false);
    setCreating(false);
    setParams(
      id
        ? { tab: 'projects', project: id, ...(view === 'overview' ? {} : { projectView: view }) }
        : { tab: 'projects' },
    );
  };
  const list = useInfiniteQuery({
    queryKey: [...key, 'list', archived],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.projectsList(archived, pageParam),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: !projectId,
  });
  const detail = useQuery({
    queryKey: [...key, projectId],
    queryFn: () => api.projectGet(projectId!),
    enabled: Boolean(projectId),
    refetchInterval: 15_000,
  });
  const project = detail.data?.project;
  const archive = useMaterialsMutation(() =>
    api.projectUpdate(project!.id, { expected_revision: project!.revision, archived: !project!.archived }),
  );
  if (!projectId) {
    const items = (list.data?.pages.flatMap((p) => p.projects) ?? []).filter((p) =>
      `${p.title} ${p.brief}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
    );
    return (
      <div className="space-y-5" data-testid="studio-projects">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl space-y-2">
            <h2 className="text-xl font-medium">{t('projects.heading')}</h2>
            <p className="text-sm leading-6 text-muted-foreground">{t('projects.intro')}</p>
          </div>
          {manage && !creating && (
            <button className={primaryClass} onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('projects.create')}
            </button>
          )}
        </div>
        {creating && <ProjectCreate onCreated={(id) => open(id)} onCancel={() => setCreating(false)} />}
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            className={`${fieldClass} max-w-sm`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('projects.search')}
            aria-label={t('projects.search')}
          />
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            {t('projects.showArchived')}
          </label>
        </div>
        <MaterialsReadStatus query={list} />
        {list.data && items.length === 0 && (
          <EmptyNote>{search ? t('projects.noMatches') : t('projects.empty')}</EmptyNote>
        )}
        <div className="divide-y divide-border border-y border-border">
          {items.map((p) => (
            <button
              key={p.id}
              onClick={() => open(p.id)}
              className="group flex w-full items-start gap-4 py-5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/5 text-primary">
                <FolderOpen className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 space-y-2">
                <span className="block break-words text-base font-medium group-hover:text-primary">
                  {p.title}
                </span>
                <span className="block line-clamp-2 text-sm text-muted-foreground">
                  {p.brief || t('projects.noBrief')}
                </span>
                <span className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
                  <span>{t('projects.sourceCount', { count: p.sources.length })}</span>
                  <span>{t('projects.outputCount', { count: p.outputs.length })}</span>
                  {p.requests.some((r) => r.status === 'open') && (
                    <span className="text-warning">
                      {t('projects.requestCount', {
                        count: p.requests.filter((r) => r.status === 'open').length,
                      })}
                    </span>
                  )}
                  {p.archived && <span>{t('projects.archived')}</span>}
                </span>
              </span>
              <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          ))}
        </div>
        {list.hasNextPage && (
          <button
            className={tapClass}
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {t('projects.showMore')}
          </button>
        )}
      </div>
    );
  }
  if (!project || !detail.data)
    return (
      <div className="space-y-4">
        <button className={tapClass} onClick={() => open()}>
          {t('projects.back')}
        </button>
        <MaterialsReadStatus query={detail} />
      </div>
    );
  const data = detail.data;
  const writable = manage && !project.archived;
  const missing = project.requests.filter((r) => r.status === 'open').length;
  const running = data.productions.filter((p) => ['pending', 'running'].includes(p.status)).length;
  const next = missing
    ? 'requests'
    : !project.sources.length
      ? 'materials'
      : running
        ? 'production'
        : 'publications';
  return (
    <div className="space-y-5" data-testid="production-project">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className={tapClass} onClick={() => open()}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t('projects.back')}
        </button>
        {manage &&
          (project.archived ? (
            <button
              className={tapClass}
              disabled={archive.isPending}
              onClick={() => archive.mutate(undefined)}
            >
              {t('projects.restore')}
            </button>
          ) : (
            <details className="max-w-md text-sm">
              <summary className="cursor-pointer py-3 text-muted-foreground">{t('projects.archive')}</summary>
              <div className="space-y-3 border-s-2 border-warning pb-3 ps-3">
                <p className="leading-6 text-muted-foreground">{t('projects.archiveHelp')}</p>
                <button
                  className={tapClass}
                  disabled={archive.isPending}
                  onClick={() => archive.mutate(undefined)}
                >
                  {t('projects.archive')}
                </button>
              </div>
            </details>
          ))}
      </div>
      <ProjectError error={archive.error} />
      <header className="space-y-4 border-t-2 border-foreground bg-surface p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="min-w-0 break-words text-2xl font-medium">{project.title}</h2>
          {project.archived && (
            <span className="rounded-md bg-surface-muted px-2 py-1 text-caption">
              {t('projects.archived')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t('projects.sourceCount', { count: project.sources.length })} ·{' '}
            {t('projects.outputCount', { count: project.outputs.length })}
          </p>
          {!project.archived && (
            <button
              className={tapClass}
              onClick={() => {
                open(project.id, next === 'requests' ? 'overview' : next);
                if (next === 'requests')
                  document.getElementById('project-requests')?.scrollIntoView({ block: 'start' });
              }}
            >
              {t(`projects.next.${next}`, { count: missing || running })}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      {project.archived && <EmptyNote>{t('projects.archivedHelp')}</EmptyNote>}
      <Tabs value={pane} onValueChange={(v) => open(project.id, v)}>
        <TabsList aria-label={t('projects.viewsLabel')} className="flex flex-wrap">
          {(['overview', 'materials', 'production', 'publications'] as const).map((v) => (
            <TabsTrigger key={v} value={v} className="min-h-11">
              {t(`projects.views.${v}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="space-y-7">
          <section className="max-w-3xl space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-medium">{t('projects.brief')}</h3>
              {writable && !editing && (
                <button className={tapClass} onClick={() => setEditing(true)}>
                  {t('projects.editBrief')}
                </button>
              )}
            </div>
            {editing ? (
              <BriefEditor project={project} onClose={() => setEditing(false)} />
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm leading-7 text-muted-foreground">
                {project.brief || t('projects.noBrief')}
              </p>
            )}
          </section>
          <ProjectRequests
            project={project}
            materials={data.materials}
            writable={writable}
            onUpload={() => open(project.id, 'materials')}
          />
        </TabsContent>
        <TabsContent value="materials">
          <ProjectMaterials project={project} materials={data.materials} writable={writable} />
        </TabsContent>
        <TabsContent value="production">
          <ProjectProduction detail={data} writable={writable} />
        </TabsContent>
        <TabsContent value="publications">
          <ProjectPublications detail={data} writable={writable} onOpenSlot={onOpenSlot} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
