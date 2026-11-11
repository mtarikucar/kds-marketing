import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Plus, Upload } from 'lucide-react';
import * as api from '@/api/projects';
import * as m from '@/api/materials';
import { MaterialsUpload } from '../materials/MaterialsUpload';
import {
  MaterialsReadStatus,
  MaterialPreview,
  materialLabel,
  fieldClass,
  primaryClass,
  tapClass,
  useMaterialsKey,
  useMaterialsMutation,
} from '../materials/MaterialsShared';
import { EmptyNote, MaterialChoice, ProjectError } from './ProjectShared';

export function ProjectMaterials({
  project,
  materials,
  writable,
}: {
  project: api.ProductionProject;
  materials: m.Material[];
  writable: boolean;
}) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [mode, setMode] = useState<'sources' | 'library' | 'upload'>('sources');
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [limit, setLimit] = useState(12);
  const sourceIds = project.sources.map((s) => s.material_id);
  const sources = materials.filter((m) => sourceIds.includes(m.id) && !m.erased_at);
  const library = useQuery({
    queryKey: [...key, 'intelligence'],
    queryFn: m.materialIntelligenceList,
    enabled: writable && mode === 'library',
  });
  const candidates = (library.data ?? []).filter(
    (row) => !row.material.erased_at && !sourceIds.includes(row.material.id),
  );
  const groups = [
    ...new Set(
      candidates.flatMap((row) => (row.intelligence?.group_name ? [row.intelligence.group_name] : [])),
    ),
  ].sort();
  const filtered = candidates.filter(
    ({ material, intelligence }) =>
      (!group || intelligence?.group_name === group) &&
      `${material.title} ${material.tags.labels?.join(' ') ?? ''} ${intelligence?.description ?? ''} ${intelligence?.group_name ?? ''}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  const attach = useMaterialsMutation(
    () =>
      api.projectMaterials(project.id, { expected_revision: project.revision, add: selected, remove: [] }),
    () => {
      setSelected([]);
      setMode('sources');
    },
  );
  const stale = sources.filter(
    (m) => project.sources.find((s) => s.material_id === m.id)?.revision !== m.revision,
  );
  const refresh = useMaterialsMutation(() =>
    api.projectMaterials(project.id, {
      expected_revision: project.revision,
      add: stale.map((m) => m.id),
      remove: [],
    }),
  );
  const remove = useMaterialsMutation((id: string) =>
    api.projectMaterials(project.id, { expected_revision: project.revision, add: [], remove: [id] }),
  );
  const toggle = (id: string) =>
    setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const uploaded = async (material: m.Material) => {
    // Fetch a fresh revision per file in a batch. A library-success/project-failure retry reuses
    // the existing material instead of uploading it twice; already-attached rows are a no-op.
    const latest = await api.projectGet(project.id);
    if (!latest.project.sources.some((s) => s.material_id === material.id)) {
      await api.projectMaterials(project.id, {
        expected_revision: latest.project.revision,
        add: [material.id],
        remove: [],
      });
    }
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-2">
          <h3 className="text-lg font-medium">{t('projects.sourcesTitle')}</h3>
          <p className="text-sm leading-6 text-muted-foreground">{t('projects.sourcesHelp')}</p>
        </div>
        {writable && (
          <div className="flex flex-wrap gap-2">
            <button
              className={tapClass}
              aria-pressed={mode === 'library'}
              onClick={() => setMode(mode === 'library' ? 'sources' : 'library')}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('projects.fromLibrary')}
            </button>
            <button
              className={primaryClass}
              aria-pressed={mode === 'upload'}
              onClick={() => setMode(mode === 'upload' ? 'sources' : 'upload')}
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              {t('projects.upload')}
            </button>
          </div>
        )}
      </div>
      {writable && mode === 'upload' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('projects.uploadHelp')}</p>
          <MaterialsUpload onOpenOlay={() => setMode('sources')} onAdded={uploaded} />
          <button className={tapClass} onClick={() => setMode('sources')}>
            {t('projects.backToSources')}
          </button>
        </div>
      )}
      {writable && mode === 'library' && (
        <section className="space-y-4 border-y border-border py-5" aria-label={t('projects.fromLibrary')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              type="search"
              aria-label={t('projects.searchMaterials')}
              placeholder={t('projects.searchMaterials')}
              className={fieldClass}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(12);
              }}
            />
            <label className="flex items-center gap-3 text-sm">
              <span>{t('materials.intelligence.group')}</span>
              <select
                className={fieldClass}
                value={group}
                onChange={(e) => {
                  setGroup(e.target.value);
                  setLimit(12);
                }}
              >
                <option value="">{t('projects.allGroups')}</option>
                {groups.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
          </div>
          <MaterialsReadStatus query={library} />
          {library.data && !filtered.length && <EmptyNote>{t('projects.noMaterialsMatch')}</EmptyNote>}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.slice(0, limit).map(({ material }) => (
              <MaterialChoice
                key={material.id}
                material={material}
                checked={selected.includes(material.id)}
                onChange={() => toggle(material.id)}
              />
            ))}
          </div>
          {filtered.length > limit && (
            <button className={tapClass} onClick={() => setLimit((v) => v + 12)}>
              {t('projects.showMore')}
            </button>
          )}
          <ProjectError error={attach.error} />
          <div className="flex flex-wrap items-center gap-3">
            <button
              className={primaryClass}
              disabled={!selected.length || selected.length + sourceIds.length > 100 || attach.isPending}
              onClick={() => attach.mutate(undefined)}
            >
              {t('projects.attachSelected', { count: selected.length })}
            </button>
            <button
              className={tapClass}
              disabled={attach.isPending}
              onClick={() => {
                setSelected([]);
                setMode('sources');
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </section>
      )}
      <ProjectError error={remove.error} />
      <ProjectError error={refresh.error} />
      {writable && stale.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-s-2 border-warning ps-4">
          <p className="text-sm text-muted-foreground">
            {t('projects.sourcesChanged', { count: stale.length })}
          </p>
          <button className={tapClass} disabled={refresh.isPending} onClick={() => refresh.mutate(undefined)}>
            {t('projects.refreshSources')}
          </button>
        </div>
      )}
      {sourceIds.length > sources.length && (
        <EmptyNote>
          {t('projects.unavailableSources', { count: sourceIds.length - sources.length })}
        </EmptyNote>
      )}
      {mode !== 'upload' && (
        <>
          {!sources.length && <EmptyNote>{t('projects.sourcesEmpty')}</EmptyNote>}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sources.map((material) => (
              <article
                key={material.id}
                className="min-w-0 space-y-3 rounded-md border border-border bg-surface p-3"
              >
                <Link
                  to={`/materials?view=library&material=${encodeURIComponent(material.id)}`}
                  className="block space-y-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MaterialPreview material={material} />
                  <span className="block truncate text-sm font-medium">{materialLabel(t, material)}</span>
                </Link>
                {material.tags.labels?.length ? (
                  <p className="line-clamp-1 text-caption text-muted-foreground">
                    {material.tags.labels.join(' · ')}
                  </p>
                ) : null}
                {writable && (
                  <button
                    className={`${tapClass} w-full`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(material.id)}
                  >
                    {t('projects.removeSource')}
                  </button>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
