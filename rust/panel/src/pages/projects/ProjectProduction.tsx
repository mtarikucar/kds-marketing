import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/projects';
import type { MaterialProductionKind } from '@/api/materials';
import {
  MaterialPreview,
  fieldClass,
  primaryClass,
  tapClass,
  useDecider,
  useMaterialsMutation,
} from '../materials/MaterialsShared';
import { EmptyNote, MaterialChoice, OpenMaterial, ProjectError, useRequestKey } from './ProjectShared';

export function ProjectProduction({ detail, writable }: { detail: api.ProjectDetail; writable: boolean }) {
  const { t } = useTranslation();
  const { project, materials, productions } = detail;
  const decider = useDecider();
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(project.revision);
  const [kind, setKind] = useState<MaterialProductionKind>('crop');
  const [instructions, setInstructions] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState(false);
  const keyFor = useRequestKey();
  const invalidated = new Set(project.invalidated_production_ids ?? []);
  const sourceIds = new Set([
    ...project.sources.map((s) => s.material_id),
    ...productions
      .filter((job) => job.status === 'completed' && !invalidated.has(job.id))
      .flatMap((job) => (job.output_material_id ? [job.output_material_id] : [])),
  ]);
  const sources = materials.filter((m) => !m.erased_at && sourceIds.has(m.id));
  const visible = productions.filter((p) => history || !invalidated.has(p.id));
  const create = useMaterialsMutation(
    () => {
      const input = {
        expected_revision: revision,
        kind,
        instructions: instructions.trim(),
        material_ids: selected,
      };
      return api.projectProduction(project.id, { ...input, request_key: keyFor(input) });
    },
    () => {
      setCreating(false);
      setInstructions('');
      setSelected([]);
    },
  );
  const canCreate = writable && decider;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-2">
          <h3 className="text-lg font-medium">{t('projects.productionTitle')}</h3>
          <p className="text-sm leading-6 text-muted-foreground">{t('projects.productionHelp')}</p>
        </div>
        {canCreate && !creating && (
          <button
            className={primaryClass}
            disabled={!sources.length || productions.length >= 100}
            onClick={() => {
              setRevision(project.revision);
              setCreating(true);
            }}
          >
            {t('projects.newProduction')}
          </button>
        )}
      </div>
      {creating && (
        <form
          className="space-y-4 border-t-2 border-foreground bg-surface p-5 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (instructions.trim() && selected.length && selected.length <= 5 && !create.isPending)
              create.mutate(undefined);
          }}
        >
          <div className="max-w-2xl space-y-4">
            <label className="block space-y-2 text-sm">
              <span>{t('materials.production.kind')}</span>
              <select
                className={fieldClass}
                value={kind}
                onChange={(e) => setKind(e.target.value as MaterialProductionKind)}
              >
                {(['edit', 'crop', 'poster'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t(`materials.production.${v}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2 text-sm">
              <span>{t('materials.production.instructions')}</span>
              <textarea
                autoFocus
                rows={3}
                required
                maxLength={2000}
                className={fieldClass}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={t('projects.productionPlaceholder')}
              />
            </label>
          </div>
          <fieldset className="space-y-3">
            <legend className="mb-3 text-sm font-medium">
              {t('projects.chooseSources', { count: selected.length })}
            </legend>
            <div className="grid max-h-[28rem] gap-3 overflow-auto sm:grid-cols-2 xl:grid-cols-3">
              {sources.map((material) => (
                <MaterialChoice
                  key={material.id}
                  material={material}
                  checked={selected.includes(material.id)}
                  onChange={() =>
                    setSelected((ids) =>
                      ids.includes(material.id)
                        ? ids.filter((id) => id !== material.id)
                        : [...ids, material.id],
                    )
                  }
                />
              ))}
            </div>
          </fieldset>
          <p className="text-sm text-muted-foreground">{t('projects.productionToolsHelp')}</p>
          <p className="text-sm text-muted-foreground">{t('projects.productionWaiting')}</p>
          <ProjectError error={create.error} />
          <div className="flex flex-wrap gap-2">
            <button
              className={primaryClass}
              disabled={!instructions.trim() || !selected.length || selected.length > 5 || create.isPending}
            >
              {t('materials.production.submit')}
            </button>
            <button
              type="button"
              className={tapClass}
              disabled={create.isPending}
              onClick={() => setCreating(false)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
      {!sources.length && <EmptyNote>{t('projects.productionNeedsSources')}</EmptyNote>}
      {invalidated.size > 0 && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
          {t('projects.showProductionHistory')}
        </label>
      )}
      {!visible.length && <EmptyNote>{t('projects.productionEmpty')}</EmptyNote>}
      <div className="space-y-5">
        {visible.map((job) => {
          const output = materials.find((m) => m.id === job.output_material_id && !m.erased_at);
          return (
            <article
              key={job.id}
              className="grid gap-5 border-t border-border py-5 sm:grid-cols-[minmax(0,1fr)_14rem]"
            >
              <div className="min-w-0 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h4 className="font-medium">{t(`materials.production.${job.kind}`)}</h4>
                  <span className="rounded-md bg-surface-muted px-2 py-1 text-caption">
                    {invalidated.has(job.id)
                      ? t('projects.invalidated')
                      : t(`materials.production.status.${job.status}`)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6">
                  {job.instructions || t('projects.instructionsRemoved')}
                </p>
                <p className="text-caption text-muted-foreground">
                  {t('projects.sourceCount', { count: job.sources.length })}
                </p>
                {invalidated.has(job.id) ? (
                  <p className="text-sm text-muted-foreground">{t('projects.invalidatedHelp')}</p>
                ) : job.status === 'pending' ? (
                  <p className="text-sm text-muted-foreground">{t('projects.productionWaiting')}</p>
                ) : job.status === 'failed' ? (
                  <p className="text-sm text-danger">{t('projects.productionFailed')}</p>
                ) : job.status === 'completed' ? (
                  <p className="text-sm text-muted-foreground">{t('projects.productionComplete')}</p>
                ) : null}
              </div>
              {output && (
                <div className="space-y-3">
                  <MaterialPreview material={output} controls />
                  <OpenMaterial material={output} />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
