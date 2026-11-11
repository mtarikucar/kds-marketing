import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/projects';
import type { Material } from '@/api/materials';
import {
  fieldClass,
  primaryClass,
  tapClass,
  materialLabel,
  useMaterialsMutation,
} from '../materials/MaterialsShared';
import { EmptyNote, ProjectError, useRequestKey } from './ProjectShared';

function RequestRow({
  request,
  project,
  materials,
  writable,
  onUpload,
}: {
  request: api.ProjectRequest;
  project: api.ProductionProject;
  materials: Material[];
  writable: boolean;
  onUpload: () => void;
}) {
  const { t } = useTranslation();
  const [resolving, setResolving] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const mutation = useMaterialsMutation(
    (status: api.ProjectRequest['status']) =>
      api.projectRequestUpdate(project.id, request.id, {
        expected_revision: project.revision,
        status,
        ...(status === 'done' ? { material_ids: selected } : {}),
      }),
    () => setResolving(false),
  );
  return (
    <article className="space-y-3 border-t border-border py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{request.text}</p>
        <span className="shrink-0 text-caption text-muted-foreground">
          {t(`projects.requestStatus.${request.status}`)}
        </span>
      </div>
      {writable && request.status === 'open' && (
        <div className="flex flex-wrap gap-2">
          <button className={tapClass} onClick={() => setResolving(!resolving)}>
            {t('projects.resolveRequest')}
          </button>
          <button className={tapClass} onClick={onUpload}>
            {t('projects.upload')}
          </button>
          <button
            className={tapClass}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate('dismissed')}
          >
            {t('projects.dismissRequest')}
          </button>
        </div>
      )}
      {writable && request.status !== 'open' && (
        <button className={tapClass} disabled={mutation.isPending} onClick={() => mutation.mutate('open')}>
          {t('projects.reopenRequest')}
        </button>
      )}
      {resolving && (
        <div className="space-y-3 rounded-md bg-surface-muted p-4">
          <p className="text-sm">{t('projects.resolveHelp')}</p>
          {!materials.length && <EmptyNote>{t('projects.resolveEmpty')}</EmptyNote>}
          <div className="max-h-56 space-y-2 overflow-auto">
            {materials
              .filter((m) => !m.erased_at)
              .map((material) => (
                <label key={material.id} className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(material.id)}
                    onChange={() =>
                      setSelected((rows) =>
                        rows.includes(material.id)
                          ? rows.filter((id) => id !== material.id)
                          : [...rows, material.id],
                      )
                    }
                  />
                  {materialLabel(t, material)}
                </label>
              ))}
          </div>
          <button
            className={primaryClass}
            disabled={!selected.length || mutation.isPending}
            onClick={() => mutation.mutate('done')}
          >
            {t('projects.confirmDelivery')}
          </button>
        </div>
      )}
      <ProjectError error={mutation.error} />
    </article>
  );
}

export function ProjectRequests({
  project,
  materials,
  writable,
  onUpload,
}: {
  project: api.ProductionProject;
  materials: Material[];
  writable: boolean;
  onUpload: () => void;
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(project.revision);
  const [text, setText] = useState('');
  const [all, setAll] = useState(false);
  const keyFor = useRequestKey();
  const create = useMaterialsMutation(
    () => {
      const input = { expected_revision: revision, text: text.trim() };
      return api.projectRequestCreate(project.id, { ...input, request_key: keyFor(input) });
    },
    () => {
      setText('');
      setCreating(false);
    },
  );
  const requests = project.requests.filter((r) => all || r.status === 'open');
  return (
    <section id="project-requests" className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-medium">{t('projects.requestsTitle')}</h3>
        {writable && !creating && (
          <button
            className={tapClass}
            onClick={() => {
              setRevision(project.revision);
              setCreating(true);
            }}
            disabled={project.requests.length >= 50}
          >
            {t('projects.requestMaterial')}
          </button>
        )}
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{t('projects.requestsHelp')}</p>
      {creating && (
        <form
          className="space-y-3 border-s-2 border-primary ps-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && !create.isPending) create.mutate(undefined);
          }}
        >
          <label className="block space-y-2 text-sm">
            <span>{t('projects.requestText')}</span>
            <textarea
              autoFocus
              rows={3}
              maxLength={2000}
              required
              className={fieldClass}
              placeholder={t('projects.requestPlaceholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <ProjectError error={create.error} />
          <div className="flex flex-wrap gap-2">
            <button className={primaryClass} disabled={!text.trim() || create.isPending}>
              {t('projects.requestMaterial')}
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
      {project.requests.some((r) => r.status !== 'open') && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          {t('projects.showResolved')}
        </label>
      )}
      {!requests.length && <EmptyNote>{t('projects.requestsEmpty')}</EmptyNote>}
      {requests.map((request) => (
        <RequestRow
          key={request.id}
          request={request}
          project={project}
          materials={materials}
          writable={writable}
          onUpload={onUpload}
        />
      ))}
    </section>
  );
}
