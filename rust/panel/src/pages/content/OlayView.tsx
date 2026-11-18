import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Check, Folder, LayoutGrid, List, Plus, Sparkles, Upload } from 'lucide-react';
import { GENEL, olayView, type FileRow, type Need, type OlayViewOut } from '@/api/content';
import * as m from '@/api/materials';
import { projectGet, projectRequestUpdate } from '@/api/projects';
import { Badge, Button, Callout, cn, EmptyState } from '@/components/ui';
import { QueryState } from '@/components/QueryState';
import {
  fieldClass,
  formatInstant,
  formatRange,
  MaterialBadges,
  MaterialPreview,
  materialLabel,
  MaterialsError,
  useDecider,
  useMaterialsMutation,
} from '../materials/MaterialsShared';
import { placeHref, useContentKey, useContentPlace } from './location';
import { PipelineRow } from './PipelineRow';
import { MissingContent } from './MissingContent';
import { ConfirmOlay, OlayDialog } from './OlayForms';
import { OpenArea } from './OpenArea';
import { useUploads } from './uploads';

export function useOlayView(id: string, enabled = true) {
  const key = useContentKey();
  return useQuery({ queryKey: [...key, 'olay', id], queryFn: () => olayView(id), refetchInterval: 30_000, enabled });
}

function FlowStrip({ flow }: { flow: OlayViewOut['flow'] }) {
  const { t } = useTranslation();
  const steps: { n: number; label: string; tone?: 'warning' | 'success' | 'danger' }[] = [
    { n: flow.files, label: t('content.flow.files') },
    { n: flow.analysed, label: flow.in_queue ? t('content.flow.analysedQueue', { n: flow.in_queue }) : t('content.flow.analysed') },
    { n: flow.in_production, label: t('content.flow.inProduction') },
    { n: flow.awaiting_approval, label: t('content.flow.awaitingApproval'), tone: flow.awaiting_approval ? 'warning' : undefined },
    { n: flow.published, label: t('content.flow.published'), tone: flow.published ? 'success' : undefined },
  ];
  if (flow.problems) steps.push({ n: flow.problems, label: t('content.flow.problems'), tone: 'danger' });
  return (
    <ol aria-label={t('content.flow.label')} className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-surface p-1.5 sm:flex sm:flex-wrap sm:items-center">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-1">
          <span className="flex min-w-0 flex-col rounded-md px-3 py-1.5">
            <b className={cn('text-xl font-medium leading-6', s.tone === 'warning' && 'text-warning', s.tone === 'success' && 'text-success', s.tone === 'danger' && 'text-danger')}>{s.n}</b>
            <span className="text-xs text-muted-foreground">{s.label}</span>
          </span>
          {i < steps.length - 1 && <ArrowRight aria-hidden="true" className="hidden h-4 w-4 text-border-strong sm:block" />}
        </li>
      ))}
    </ol>
  );
}

function SectionHead({ title, count, children }: { title: string; count?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="text-base font-medium">{title}</h3>
      {count !== undefined && <span className="font-mono text-xs text-muted-foreground">{count}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** A file of the folder as a card (or a line), opening its drawer. */
function FileCard({ row, list }: { row: FileRow; list: boolean }) {
  const { t } = useTranslation();
  const [place] = useContentPlace();
  const { material, intelligence } = row;
  const analysis = intelligence.status !== 'completed' && (
    <Badge tone={intelligence.status === 'failed' ? 'danger' : 'info'}>{t(`materials.intelligence.${intelligence.status}`)}</Badge>
  );
  const used = row.used_in.length > 0 && <Badge>{t('content.file.usedIn', { count: row.used_in.length })}</Badge>;
  const to = placeHref({ ...place, file: material.id });
  if (list)
    return (
      <li>
        <Link to={to} className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]">
          <span className="h-10 w-10 overflow-hidden rounded [&_img]:h-10 [&_img]:object-cover [&_span]:h-10 [&_video]:h-10 [&_.text-xs]:hidden"><MaterialPreview material={material} /></span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{materialLabel(t, material)}</span>
            <span className="block truncate text-xs text-muted-foreground">{intelligence.description}</span>
          </span>
          <span className="col-start-2 flex flex-wrap gap-1 sm:col-start-auto sm:justify-end">{analysis}<MaterialBadges material={material} />{used}</span>
        </Link>
      </li>
    );
  return (
    <li className="min-w-0">
      <Link to={to} className="flex h-full min-w-0 flex-col gap-2 overflow-hidden rounded-md border border-border bg-surface p-2 hover:border-border-strong hover:shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <MaterialPreview material={material} />
        <span className="truncate text-sm font-medium">{materialLabel(t, material)}</span>
        <span className="flex flex-wrap gap-1">{analysis}<MaterialBadges material={material} />{used}</span>
      </Link>
    </li>
  );
}

function Files({ files }: { files: FileRow[] }) {
  const { t } = useTranslation();
  const key = useContentKey();
  const [list, setList] = useState(false);
  const [review, setReview] = useState(false);
  // The library's own rule of what a person still has to look at (`state=needs_review`).
  const needs = useQuery({ queryKey: [...key, 'needs-review'], queryFn: () => m.materialsList({ state: 'needs_review' }), enabled: review });
  const shown = review ? files.filter((f) => needs.data?.some((x) => x.id === f.material.id)) : files;
  return (
    <section aria-labelledby="olay-files" className="space-y-3">
      <SectionHead title={t('content.files.title')} count={files.length}>
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
          {t('content.files.review')}
        </label>
        <div role="group" aria-label={t('content.files.layout')} className="inline-flex gap-0.5 rounded-md bg-surface-muted p-0.5">
          {([false, true] as const).map((asList) => (
            <button
              key={String(asList)}
              type="button"
              aria-pressed={list === asList}
              aria-label={t(asList ? 'content.files.list' : 'content.files.grid')}
              onClick={() => setList(asList)}
              className={cn('grid h-8 w-8 place-items-center rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', list === asList && 'bg-surface text-foreground shadow-xs')}
            >
              {asList ? <List aria-hidden="true" className="h-4 w-4" /> : <LayoutGrid aria-hidden="true" className="h-4 w-4" />}
            </button>
          ))}
        </div>
      </SectionHead>
      <h4 id="olay-files" className="sr-only">{t('content.files.title')}</h4>
      {review && needs.isError && <MaterialsError error={needs.error} onRetry={needs.refetch} />}
      {!shown.length ? (
        <p className="rounded-lg border border-dashed border-border-strong p-6 text-center text-sm text-muted-foreground">
          {t(review ? 'content.files.noReview' : 'content.files.empty')}
        </p>
      ) : (
        <ul className={list ? 'overflow-hidden rounded-md border border-border bg-surface' : 'grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]'}>
          {shown.map((f) => <FileCard key={f.material.id} row={f} list={list} />)}
        </ul>
      )}
    </section>
  );
}

/** One of the folder's "Eksikler": a çekim listesi request, or a capture a content asked for. */
function NeedRow({ need, folder, materialsWork, contentWork }: { need: Need; folder: string; materialsWork: boolean; contentWork: boolean }) {
  const { t, i18n } = useTranslation();
  const uploads = useUploads();
  const resolve = useMaterialsMutation((status: 'done' | 'dismissed') => m.shootResolve(need.id, status));
  // A capture request moves its content's revision; dismiss it at the revision there now.
  const dismiss = useMaterialsMutation(async () =>
    projectRequestUpdate(need.project_id!, need.id, { expected_revision: (await projectGet(need.project_id!)).project.revision, status: 'dismissed' }),
  );
  const open = need.status === 'open';
  const shoot = need.kind === 'shoot_request';
  const can = shoot ? materialsWork : contentWork;
  return (
    <li className={cn('grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto]')}>
      <span aria-hidden="true" className={cn('mt-0.5 grid h-[1.125rem] w-[1.125rem] place-items-center rounded border-[1.5px]', need.status === 'done' ? 'border-primary bg-primary text-primary-foreground' : need.status === 'dismissed' ? 'border-border-strong bg-surface-muted' : 'border-border-strong')}>
        {need.status === 'done' && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <div className="min-w-0 space-y-1">
        <p className={cn('break-words text-sm', !open && 'text-muted-foreground line-through')}>{need.text}</p>
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{t(shoot ? 'content.needs.shoot' : 'content.needs.material')}</span>
          {need.project_id && (
            <span>
              {t('content.needs.askedBy')}{' '}
              <Link className="text-primary underline" to={placeHref({ olay: folder, content: need.project_id })}>{need.project_title ?? t('content.detail.label')}</Link>
            </span>
          )}
          <span>{formatInstant(need.created_at, i18n.language)}</span>
          {need.status !== 'open' && <span>{t(`content.needs.status.${need.status}`)}</span>}
        </p>
        <MaterialsError error={resolve.error ?? dismiss.error} />
      </div>
      {open && can && (
        <div className="col-start-2 flex flex-wrap gap-2 sm:col-start-auto sm:justify-end">
          {uploads && (
            <Button size="sm" onClick={uploads.pick}>
              <Upload aria-hidden="true" className="h-4 w-4" />
              {t('content.upload.button')}
            </Button>
          )}
          {shoot && <Button size="sm" variant="outline" loading={resolve.isPending && resolve.variables === 'done'} disabled={resolve.isPending} onClick={() => resolve.mutate('done')}>{t('materials.shoot.done')}</Button>}
          <Button size="sm" variant="ghost" loading={shoot ? resolve.isPending && resolve.variables === 'dismissed' : dismiss.isPending} disabled={resolve.isPending || dismiss.isPending} onClick={() => (shoot ? resolve.mutate('dismissed') : dismiss.mutate(undefined))}>
            {t('materials.shoot.dismiss')}
          </Button>
        </div>
      )}
    </li>
  );
}

/** Adds a request of the owner's own to the çekim listesi ("human:" keyed; replayed by its key on a retry). */
function AddShoot() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const requestKey = useRef<string | null>(null);
  const add = useMaterialsMutation(
    (value: string) => {
      requestKey.current ??= crypto.randomUUID();
      return m.shootRequest({ request_key: requestKey.current, text: value });
    },
    () => {
      setText('');
      requestKey.current = null;
    },
  );
  return (
    <form
      className="space-y-2 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!add.isPending && text.trim()) add.mutate(text.trim());
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t('materials.shoot.add')}</span>
        <textarea className={fieldClass} rows={2} maxLength={500} value={text} onChange={(e) => { setText(e.target.value); requestKey.current = null; }} />
      </label>
      <Button type="submit" size="sm" loading={add.isPending} disabled={!text.trim()}>{t('materials.shoot.addSubmit')}</Button>
      <MaterialsError error={add.error} />
    </form>
  );
}

function Needs({ needs, folder, materialsWork, contentWork }: { needs: Need[]; folder: string; materialsWork: boolean; contentWork: boolean }) {
  const { t } = useTranslation();
  const open = needs.filter((n) => n.status === 'open').length;
  return (
    <section id="eksikler" aria-labelledby="eksikler-title" className="scroll-mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="eksikler-title" className="text-base font-medium">{t('content.needs.title')}</h3>
        <span className="font-mono text-xs text-muted-foreground">{t('content.needs.open', { count: open })}</span>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-surface">
        {needs.length ? (
          <ul>{needs.map((n) => <NeedRow key={`${n.kind}-${n.id}`} need={n} folder={folder} materialsWork={materialsWork} contentWork={contentWork} />)}</ul>
        ) : (
          <p className="px-4 py-4 text-sm text-muted-foreground">{t('content.needs.empty')}</p>
        )}
        {folder === GENEL && materialsWork && <div className="border-t border-border"><AddShoot /></div>}
      </div>
    </section>
  );
}

/**
 * One olay as a folder, or Genel: what it is, its flow from files to publication, its contents
 * as production lines, its files, and its "Eksikler". `contents` and `files` are left out for a
 * session without their permission, as the server leaves them out.
 */
export function OlayView({
  id,
  contentOn,
  manage,
  materialsWork,
  contentWork,
}: {
  id: string;
  /** The content module is on: contents are shown. */
  contentOn: boolean;
  manage: boolean;
  materialsWork: boolean;
  contentWork: boolean;
}) {
  const { t, i18n } = useTranslation();
  const decider = useDecider();
  const location = useLocation();
  const [place, go] = useContentPlace();
  const view = useOlayView(id);
  const [editing, setEditing] = useState(false);
  const [opening, setOpening] = useState(false);
  const data = view.data;
  const olay = data?.olay ?? null;
  const contents = contentOn ? data?.contents ?? null : null;
  // A link to the folder's "Eksikler" lands on them once they are drawn.
  useEffect(() => {
    if (data && location.hash === '#eksikler') document.getElementById('eksikler')?.scrollIntoView?.({ block: 'start' });
  }, [data, location.hash]);
  const toggle = (areaId: string) =>
    place.content === areaId ? go({ ...place, content: undefined }, { replace: true }) : go({ ...place, content: areaId });
  return (
    <section aria-label={olay?.title ?? t('content.genel')} className="min-w-0 space-y-6">
      <QueryState query={view} keepOnError>
        {data && (
          <>
            <header className="flex flex-wrap items-start gap-3">
              <Folder aria-hidden="true" className="h-9 w-9 shrink-0 fill-surface-muted text-muted-foreground" strokeWidth={1.2} />
              <div className="min-w-0 flex-[1_1_15rem]">
                <h2 className="flex flex-wrap items-center gap-2 text-xl font-medium">
                  <span className="min-w-0 break-words">{olay ? olay.title : t('content.genel')}</span>
                  {olay?.status === 'proposed' ? <Badge tone="primary">{t('content.olay.proposed')}</Badge>
                    : olay ? <Badge tone={olay.ends_on < m.istanbulDay(new Date()) ? 'neutral' : 'success'}>{t(olay.ends_on < m.istanbulDay(new Date()) ? 'content.olay.ended' : 'content.olay.active')}</Badge>
                      : <Badge>{t('content.olay.always')}</Badge>}
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {olay ? <>{t(`materials.kind.${olay.kind}`)} · {formatRange(olay.starts_on, olay.ends_on, i18n.language)}{olay.place ? ` · ${olay.place}` : ''}</> : t('content.genelHelp')}
                </p>
                {olay?.client?.organization && <p className="text-sm">{t('materials.olay.organization')}: {olay.client.organization}</p>}
                {olay?.notes && <p className="mt-1 whitespace-pre-wrap text-sm">{olay.notes}</p>}
              </div>
              {olay && materialsWork && (decider || olay.status === 'proposed') && (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{t('materials.olay.edit')}</Button>
              )}
            </header>
            {olay?.status === 'proposed' && (
              <Callout tone="info" icon={<Sparkles className="h-4 w-4" />} title={t('content.olay.proposedTitle')}>
                <div className="flex flex-wrap items-center gap-3">
                  <p className="min-w-0 flex-[1_1_16rem] text-sm">{t(decider ? 'content.olay.proposedHelp' : 'content.olay.proposedHelpOther')}</p>
                  {decider && <ConfirmOlay olay={olay} />}
                </div>
              </Callout>
            )}
            <FlowStrip flow={data.flow} />
            {contents && (
              <section aria-labelledby="olay-contents" className="space-y-3">
                <SectionHead title={t('content.contents.title')} count={contents.length}>
                  {manage && (
                    <Button variant="outline" size="sm" onClick={() => setOpening(true)}>
                      <Plus aria-hidden="true" className="h-4 w-4" />
                      {t('contentAreas.open')}
                    </Button>
                  )}
                </SectionHead>
                <h4 id="olay-contents" className="sr-only">{t('content.contents.title')}</h4>
                {place.content && !contents.some((c) => c.area.id === place.content) && <MissingContent id={place.content} manage={manage} files={materialsWork} />}
                {contents.length ? (
                  contents.map((row) => <PipelineRow key={row.area.id} row={row} expanded={place.content === row.area.id} onToggle={() => toggle(row.area.id)} manage={manage} files={materialsWork} />)
                ) : (
                  <EmptyState title={t('content.contents.empty')} description={t('content.contents.emptyHelp')} />
                )}
              </section>
            )}
            {data.files && <Files files={data.files} />}
            <Needs needs={data.needs} folder={id} materialsWork={materialsWork} contentWork={contentWork} />
          </>
        )}
      </QueryState>
      {editing && olay && <OlayDialog key={olay.revision} olay={olay} onClose={() => setEditing(false)} />}
      {opening && (
        <OpenArea
          olayId={olay?.id}
          olayTitle={olay?.title ?? t('content.genel')}
          onClose={() => setOpening(false)}
          onCreated={(areaId) => { setOpening(false); go({ olay: id, content: areaId }); }}
        />
      )}
    </section>
  );
}
