import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import * as api from '@/api/projects';
import { listCapabilities } from '@/api/capabilities';
import { getStrategy } from '@/api/strategy';
import { POST_FORMATS, postsList, type PostFormat } from '@/api/posts';
import type { CapabilityOut, Hypothesis } from '@/api/types';
import { SlotEditor } from '../StudioToday';
import { useStudioKey, contentTypeLabel } from '../StudioShared';
import {
  MaterialsReadStatus,
  fieldClass,
  primaryClass,
  tapClass,
  useMaterialsMutation,
} from '../materials/MaterialsShared';
import { EmptyNote, MaterialChoice, ProjectError, useRequestKey } from './ProjectShared';

function localInput(at: string | null) {
  if (!at) return '';
  const date = new Date(at);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
const outputInput = (output: api.ProjectOutput): api.ProjectOutputInput => ({
  id: output.id,
  title: output.title,
  format: output.format,
  target_at: output.target_at,
  capability_id: output.capability_id,
});

function OutputForm({
  project,
  output,
  channels,
  onClose,
}: {
  project: api.ProductionProject;
  output?: api.ProjectOutput;
  channels: CapabilityOut[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // A background refresh must not silently retarget a form opened against an older project.
  const [base] = useState(project);
  const [title, setTitle] = useState(output?.title ?? '');
  const [format, setFormat] = useState<PostFormat>(output?.format ?? 'feed_post');
  const [channel, setChannel] = useState(output?.capability_id ?? '');
  const [at, setAt] = useState(localInput(output?.target_at ?? null));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const save = useMaterialsMutation(() => {
    const next: api.ProjectOutputInput = {
      ...(output ? { id: output.id } : {}),
      title: title.trim(),
      format,
      capability_id: channel || null,
      target_at: at ? new Date(at).toISOString() : null,
    };
    return api.projectUpdate(project.id, {
      expected_revision: base.revision,
      outputs: output
        ? base.outputs.map((o) => (o.id === output.id ? next : outputInput(o)))
        : [...base.outputs.map(outputInput), next],
    });
  }, onClose);
  return (
    <form
      className="max-w-3xl space-y-4 border-t-2 border-foreground bg-surface p-5 sm:p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && !save.isPending) save.mutate(undefined);
      }}
    >
      <h4 className="font-medium">{t(output ? 'projects.editOutput' : 'projects.addOutput')}</h4>
      <label className="block space-y-2 text-sm">
        <span>{t('projects.outputTitle')}</span>
        <input
          autoFocus
          required
          maxLength={160}
          className={fieldClass}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('projects.outputPlaceholder')}
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-2 text-sm">
          <span>{t('projects.format')}</span>
          <select
            className={fieldClass}
            value={format}
            onChange={(e) => setFormat(e.target.value as PostFormat)}
          >
            {POST_FORMATS.map((v) => (
              <option key={v} value={v}>
                {t(`posts.format.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-2 text-sm">
          <span>{t('projects.channel')}</span>
          <select className={fieldClass} value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">{t('projects.chooseLater')}</option>
            {channels
              .filter((c) => c.effective_status !== 'retired')
              .map((c) => (
                <option key={c.capability.id} value={c.capability.id}>
                  {c.capability.name}
                  {c.effective_status !== 'verified' ? ` · ${t('projects.connectionNeeded')}` : ''}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label className="block space-y-2 text-sm">
        <span>{t('projects.targetTime')}</span>
        <input
          type="datetime-local"
          className={fieldClass}
          value={at}
          onChange={(e) => setAt(e.target.value)}
        />
        <span className="block text-caption text-muted-foreground">{t('projects.timezone', { zone })}</span>
      </label>
      <p className="text-sm leading-6 text-muted-foreground">{t('projects.targetHint')}</p>
      <ProjectError error={save.error} />
      <div className="flex flex-wrap gap-2">
        <button className={primaryClass} disabled={!title.trim() || save.isPending}>
          {t('projects.saveOutput')}
        </button>
        <button type="button" className={tapClass} disabled={save.isPending} onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

function ScheduleForm({
  detail,
  output,
  hypotheses,
  onClose,
}: {
  detail: api.ProjectDetail;
  output: api.ProjectOutput;
  hypotheses: Hypothesis[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [revision] = useState(detail.project.revision);
  const options = hypotheses.filter((h) => h.state !== 'retired' && h.cadence.organic);
  const [hypothesisId, setHypothesisId] = useState(options.length === 1 ? options[0].id : '');
  const hypothesis = options.find((h) => h.id === hypothesisId);
  const contentTypes = hypothesis?.cadence.organic?.content_types ?? [];
  const [contentType, setContentType] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const keyFor = useRequestKey();
  const invalidated = new Set(detail.project.invalidated_production_ids ?? []);
  const eligibleIds = new Set([
    ...detail.project.sources.map((s) => s.material_id),
    ...detail.productions
      .filter((p) => p.status === 'completed' && !invalidated.has(p.id))
      .flatMap((p) => (p.output_material_id ? [p.output_material_id] : [])),
  ]);
  const materials = detail.materials.filter((m) => !m.erased_at && eligibleIds.has(m.id));
  const schedule = useMaterialsMutation(() => {
    const input = {
      expected_revision: revision,
      hypothesis_id: hypothesisId,
      ...(contentType ? { content_type: contentType } : {}),
      material_ids: selected,
    };
    return api.projectSchedule(detail.project.id, output.id, { ...input, request_key: keyFor(input) });
  }, onClose);
  return (
    <form
      className="space-y-4 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (hypothesisId && selected.length && !schedule.isPending) schedule.mutate(undefined);
      }}
    >
      <h4 className="font-medium">{t('projects.scheduleTitle')}</h4>
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('projects.scheduleHelp')}</p>
      {!options.length ? (
        <EmptyNote>
          {t('projects.strategyNeeded')}{' '}
          <Link className="underline underline-offset-4" to="/strategy">
            {t('projects.openStrategy')}
          </Link>
        </EmptyNote>
      ) : (
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <label className="block space-y-2 text-sm">
            <span>{t('projects.hypothesis')}</span>
            <select
              required
              className={fieldClass}
              value={hypothesisId}
              onChange={(e) => {
                setHypothesisId(e.target.value);
                setContentType('');
              }}
            >
              <option value="">{t('projects.chooseHypothesis')}</option>
              {options.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.title}
                </option>
              ))}
            </select>
          </label>
          {contentTypes.length > 0 && (
            <label className="block space-y-2 text-sm">
              <span>{t('projects.contentType')}</span>
              <select
                className={fieldClass}
                value={contentType}
                onChange={(e) => setContentType(e.target.value)}
              >
                <option value="">{t('projects.useStrategyDefault')}</option>
                {contentTypes.map((c) => (
                  <option key={c.key} value={c.key}>
                    {contentTypeLabel(t, c.key)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <fieldset className="space-y-3">
        <legend className="mb-3 text-sm font-medium">{t('projects.publishMaterials')}</legend>
        <div className="grid max-h-[28rem] gap-3 overflow-auto sm:grid-cols-2 xl:grid-cols-3">
          {materials.map((material) => (
            <MaterialChoice
              key={material.id}
              material={material}
              checked={selected.includes(material.id)}
              onChange={() =>
                setSelected((ids) =>
                  ids.includes(material.id) ? ids.filter((id) => id !== material.id) : [...ids, material.id],
                )
              }
            />
          ))}
        </div>
      </fieldset>
      {!materials.length && <EmptyNote>{t('projects.productionNeedsSources')}</EmptyNote>}
      <p className="text-sm text-muted-foreground">{t('projects.schedulePermissionHelp')}</p>
      <ProjectError error={schedule.error} />
      <div className="flex flex-wrap gap-2">
        <button className={primaryClass} disabled={!hypothesisId || !selected.length || schedule.isPending}>
          {t('projects.schedule')}
        </button>
        <button type="button" className={tapClass} disabled={schedule.isPending} onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

function ExistingPublication({
  detail,
  output,
  onLinked,
}: {
  detail: api.ProjectDetail;
  output: api.ProjectOutput;
  onLinked: () => void;
}) {
  const { t, i18n } = useTranslation();
  const key = useStudioKey();
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState('');
  const list = useQuery({ queryKey: [...key, 'posts', 'list'], queryFn: () => postsList(), enabled: open });
  const materialIds = new Set(detail.materials.map((m) => m.id));
  const candidates = (list.data?.posts ?? []).filter(
    ({ post }) =>
      post.format === output.format &&
      (!output.capability_id || output.capability_id === post.capability_id) &&
      (!output.target_at || new Date(output.target_at).getTime() === new Date(post.publish_at).getTime()) &&
      post.material_ids.length > 0 &&
      post.material_ids.every((id) => materialIds.has(id)),
  );
  const link = useMaterialsMutation(
    () =>
      api.projectPublication(detail.project.id, {
        expected_revision: detail.project.revision,
        output_id: output.id,
        slot_id: slot,
      }),
    onLinked,
  );
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="space-y-3">
      <summary className="cursor-pointer py-2 text-sm text-muted-foreground">
        {t('projects.linkExisting')}
      </summary>
      {open && (
        <div className="space-y-3">
          <MaterialsReadStatus query={list} />
          <p className="text-sm text-muted-foreground">{t('projects.linkHelp')}</p>
          {!candidates.length && list.data && <EmptyNote>{t('projects.noExisting')}</EmptyNote>}
          <label className="block space-y-2 text-sm">
            <span>{t('projects.existingPublication')}</span>
            <select className={fieldClass} value={slot} onChange={(e) => setSlot(e.target.value)}>
              <option value="">{t('projects.choosePublication')}</option>
              {candidates.map(({ post, slot }) => (
                <option key={slot.id} value={slot.id}>
                  {new Date(post.publish_at).toLocaleString(i18n.language)} · {t(`studio.${slot.state}`)}
                </option>
              ))}
            </select>
          </label>
          <ProjectError error={link.error} />
          <button
            className={tapClass}
            disabled={!slot || link.isPending}
            onClick={() => link.mutate(undefined)}
          >
            {t('projects.link')}
          </button>
        </div>
      )}
    </details>
  );
}

export function ProjectPublications({
  detail,
  writable,
  onOpenSlot,
}: {
  detail: api.ProjectDetail;
  writable: boolean;
  onOpenSlot: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const key = useStudioKey();
  const { project } = detail;
  const channels = useQuery({
    queryKey: [...key, 'project-channels'],
    queryFn: () => listCapabilities({ group: 'social_account' }),
  });
  const strategy = useQuery({ queryKey: [...key, 'project-strategy'], queryFn: getStrategy });
  const hypotheses = strategy.data?.approved?.hypotheses ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [slotEditor, setSlotEditor] = useState<string | null>(null);
  const remove = useMaterialsMutation((id: string) =>
    api.projectUpdate(project.id, {
      expected_revision: project.revision,
      outputs: project.outputs.filter((o) => o.id !== id).map(outputInput),
    }),
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-2">
          <h3 className="text-lg font-medium">{t('projects.publicationsTitle')}</h3>
          <p className="text-sm leading-6 text-muted-foreground">{t('projects.publicationsHelp')}</p>
        </div>
        {writable && editing !== 'new' && (
          <button
            className={primaryClass}
            disabled={project.outputs.length >= 20}
            onClick={() => setEditing('new')}
          >
            {t('projects.addOutput')}
          </button>
        )}
      </div>
      <MaterialsReadStatus query={channels} />
      <MaterialsReadStatus query={strategy} />
      <ProjectError error={remove.error} />
      {editing === 'new' && (
        <OutputForm
          key="new"
          project={project}
          channels={channels.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
      {!project.outputs.length && <EmptyNote>{t('projects.outputsEmpty')}</EmptyNote>}
      <div className="space-y-5">
        {project.outputs.map((output) => {
          const publication = detail.publications.find((p) => p.output_id === output.id);
          const channel = channels.data?.find((c) => c.capability.id === output.capability_id);
          const canSchedule = Boolean(
            output.capability_id && output.target_at && new Date(output.target_at).getTime() > Date.now(),
          );
          return (
            <article key={output.id} className="space-y-4 border-t border-border py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                  <h4 className="break-words text-lg font-medium">{output.title}</h4>
                  <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    <span>{t(`posts.format.${output.format}`)}</span>
                    <span>{channel?.capability.name ?? t('projects.channelNotChosen')}</span>
                    <span>
                      {output.target_at
                        ? new Date(output.target_at).toLocaleString(i18n.language)
                        : t('projects.timeNotChosen')}
                    </span>
                  </p>
                </div>
                <span className="rounded-md bg-surface-muted px-2 py-1 text-caption">
                  {publication
                    ? t(`studio.${publication.slot.state}`)
                    : output.slot_id
                      ? t('projects.publicationUnavailable')
                      : t('projects.outputDraft')}
                </span>
              </div>
              {!output.slot_id && <p className="text-sm text-muted-foreground">{t('projects.targetHint')}</p>}
              {writable && !output.slot_id && editing !== output.id && (
                <div className="flex flex-wrap gap-2">
                  <button
                    className={primaryClass}
                    disabled={!canSchedule}
                    onClick={() => setScheduling(scheduling === output.id ? null : output.id)}
                  >
                    {t('projects.schedule')}
                  </button>
                  <button
                    className={tapClass}
                    onClick={() => {
                      setScheduling(null);
                      setEditing(output.id);
                    }}
                  >
                    {t('projects.editOutput')}
                  </button>
                  <button
                    className={tapClass}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(output.id)}
                  >
                    {t('projects.removeOutput')}
                  </button>
                </div>
              )}
              {writable && !output.slot_id && !canSchedule && (
                <p className="text-caption text-muted-foreground">{t('projects.scheduleNeedsTarget')}</p>
              )}
              {editing === output.id && (
                <OutputForm
                  key={output.id}
                  project={project}
                  output={output}
                  channels={channels.data ?? []}
                  onClose={() => setEditing(null)}
                />
              )}
              {scheduling === output.id && !output.slot_id && (
                <ScheduleForm
                  key={output.id}
                  detail={detail}
                  output={output}
                  hypotheses={hypotheses}
                  onClose={() => setScheduling(null)}
                />
              )}
              {writable && !output.slot_id && (
                <ExistingPublication detail={detail} output={output} onLinked={() => setScheduling(null)} />
              )}
              {output.slot_id && (
                <div className="flex flex-wrap gap-2">
                  <button
                    className={primaryClass}
                    aria-expanded={slotEditor === output.slot_id}
                    onClick={() => setSlotEditor(slotEditor === output.slot_id ? null : output.slot_id)}
                  >
                    {t('projects.preparePublication')}
                  </button>
                  <button className={tapClass} onClick={() => onOpenSlot(output.slot_id!)}>
                    {t('projects.allPublicationActions')}
                  </button>
                </div>
              )}
              {publication?.slot.state === 'planned' && (
                <p className="text-sm text-muted-foreground">{t('projects.plannedHelp')}</p>
              )}
              {slotEditor === output.slot_id && output.slot_id && (
                <SlotEditor
                  key={output.slot_id}
                  id={output.slot_id}
                  tiktok={output.format === 'tiktok_video'}
                  close={() => setSlotEditor(null)}
                />
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
