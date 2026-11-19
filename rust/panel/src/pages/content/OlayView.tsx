import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link, useLocation } from 'react-router-dom';
import { Check, ChevronDown, Folder, LayoutGrid, List, Lock, Plus, Sparkles, Upload } from 'lucide-react';
import { GENEL, olayView, type FileRow, type Need } from '@/api/content';
import * as m from '@/api/materials';
import { projectGet, projectRequestUpdate } from '@/api/projects';
import { Badge, Button, Callout, cn } from '@/components/ui';
import { QueryState } from '@/components/QueryState';
import {
  fieldClass,
  formatRange,
  MaterialPreview,
  materialLabel,
  MaterialsError,
  useDecider,
  useMaterialsMutation,
} from '../materials/MaterialsShared';
import { areaTime } from './AreaShared';
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

function SectionHead({ id, title, count, note, children }: { id?: string; title: string; count?: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
      <h3 id={id} className="text-base font-medium">{title}</h3>
      {count !== undefined && <span className="font-mono text-xs text-muted-foreground">{count}</span>}
      {note}
      <span className="flex-1" />
      {children}
    </div>
  );
}

type Tone = 'info' | 'warning' | 'danger';
/** Something about a file a person should look at; a healthy shareable file has none. */
export interface FileMark { text: string; tone: Tone }
const MARK_TEXT: Record<Tone, string> = { info: 'text-info', warning: 'text-warning', danger: 'text-danger' };
const MARK_DOT: Record<Tone, string> = { info: 'bg-info', warning: 'bg-warning', danger: 'bg-danger' };

/** What needs attention on a file, the most serious first: analysis, permission, quality. */
export function fileMarks(t: TFunction, row: FileRow): FileMark[] {
  const { material, intelligence } = row;
  const marks: FileMark[] = [];
  if (!material.share) marks.push({ text: t('materials.noPermission'), tone: 'warning' });
  else if (material.share.permission === 'not_shareable') marks.push({ text: t('materials.share.not_shareable'), tone: 'danger' });
  if (intelligence.status === 'failed') marks.push({ text: t('materials.intelligence.failed'), tone: 'danger' });
  else if (intelligence.status !== 'completed') marks.push({ text: t(`materials.intelligence.${intelligence.status}`), tone: 'info' });
  const quality = material.tags.quality;
  if (quality === 'unusable' || quality === 'needs_crop') marks.push({ text: t(`materials.quality.${quality}`), tone: quality === 'unusable' ? 'danger' : 'warning' });
  const rank: Record<Tone, number> = { danger: 0, warning: 1, info: 2 };
  return marks.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** A file waits for its analysis: the agent has not finished looking at it. */
const awaitsAnalysis = (f: FileRow) => !f.material.erased_at && (f.intelligence.status === 'pending' || f.intelligence.status === 'running');

/** A file of the folder as a small square (or a line), opening its drawer. */
function FileCard({ row, list }: { row: FileRow; list: boolean }) {
  const { t } = useTranslation();
  const [place] = useContentPlace();
  const { material, intelligence } = row;
  const marks = material.erased_at ? [{ text: t('materials.erased'), tone: 'danger' as const }] : fileMarks(t, row);
  const to = placeHref({ ...place, file: material.id });
  const label = materialLabel(t, material);
  if (list)
    return (
      <li>
        <Link to={to} className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-2.5 border-b border-border px-2 py-1 last:border-b-0 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[2rem_minmax(0,1fr)_auto]">
          <span className="h-8 w-8 overflow-hidden rounded [&>div]:h-full [&_[role=img]]:h-8 [&_[role=img]]:rounded [&_img]:h-8 [&_img]:rounded [&_svg]:h-4 [&_svg]:w-4 [&_.text-xs]:hidden [&_video]:h-8 [&_video]:object-cover"><MaterialPreview material={material} /></span>
          <span className="flex min-w-0 items-baseline gap-2 text-sm">
            <span className="shrink-0 truncate font-medium sm:max-w-[50%]">{label}</span>
            {intelligence.description && <span className="min-w-0 truncate text-xs text-muted-foreground max-sm:hidden">{intelligence.description}</span>}
          </span>
          <span className="col-start-2 flex flex-wrap gap-x-2 text-xs sm:col-start-auto sm:justify-end">
            {marks.map((mark) => <span key={mark.text} className={MARK_TEXT[mark.tone]}>{mark.text}</span>)}
            {row.used_in.length > 0 && <span className="text-muted-foreground">{t('content.file.usedIn', { count: row.used_in.length })}</span>}
          </span>
        </Link>
      </li>
    );
  const [first, ...rest] = marks;
  return (
    <li className="min-w-0">
      <Link to={to} title={[label, ...marks.map((mark) => mark.text)].join(' · ')} className="group block min-w-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="relative block aspect-square overflow-hidden rounded-md border border-border bg-surface-muted group-hover:border-border-strong [&>div]:h-full [&_[role=img]]:h-full [&_[role=img]]:rounded-none [&_img]:h-full [&_img]:rounded-none [&_.text-xs]:hidden [&_video]:h-full [&_video]:rounded-none [&_video]:object-cover">
          <MaterialPreview material={material} />
          {first && <span aria-hidden="true" className={cn('absolute end-1 top-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface', MARK_DOT[first.tone])} />}
        </span>
        <span className="mt-1 block truncate text-xs font-medium">{label}</span>
        {first && (
          <span className={cn('line-clamp-2 block break-words text-micro leading-tight', MARK_TEXT[first.tone])}>
            {first.text}
            {rest.length > 0 && <span className="sr-only">{rest.map((mark) => `, ${mark.text}`).join('')}</span>}
            {rest.length > 0 && <span aria-hidden="true" className="text-muted-foreground"> +{rest.length}</span>}
          </span>
        )}
      </Link>
    </li>
  );
}

function Files({ files, unshared }: { files: FileRow[]; unshared: number }) {
  const { t } = useTranslation();
  const key = useContentKey();
  const [list, setList] = useState(false);
  const [review, setReview] = useState(false);
  const [showErased, setShowErased] = useState(false);
  // The library's own rule of what a person still has to look at (`state=needs_review`).
  const needs = useQuery({ queryKey: [...key, 'needs-review'], queryFn: () => m.materialsList({ state: 'needs_review' }), enabled: review });
  const shown = review ? files.filter((f) => needs.data?.some((x) => x.id === f.material.id)) : files;
  // An erased file is kept only to show where it was used: folded into one line.
  const live = shown.filter((f) => !f.material.erased_at);
  const erased = shown.filter((f) => f.material.erased_at);
  const analysing = files.filter(awaitsAnalysis).length;
  const listClass = 'overflow-hidden rounded-md border border-border bg-surface';
  return (
    <section aria-labelledby="olay-files" className="space-y-2">
      <SectionHead
        id="olay-files"
        title={t('content.files.title')}
        count={files.filter((f) => !f.material.erased_at).length}
        note={analysing > 0 && (
          <Link to={placeHref({ view: 'queue' })} className="text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground">
            {t('content.files.analysing', { count: analysing })}
          </Link>
        )}
      >
        <label className="flex min-h-8 items-center gap-2 text-sm">
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
              className={cn('grid h-7 w-7 place-items-center rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', list === asList && 'bg-surface text-foreground shadow-xs')}
            >
              {asList ? <List aria-hidden="true" className="h-4 w-4" /> : <LayoutGrid aria-hidden="true" className="h-4 w-4" />}
            </button>
          ))}
        </div>
      </SectionHead>
      {unshared > 0 && (
        <Callout tone="warning" icon={<Lock className="h-4 w-4" />} title={t('content.files.noShareTitle', { count: unshared })}>
          <p className="text-sm">{t('content.files.noShareHelp')}</p>
        </Callout>
      )}
      {review && needs.isError && <MaterialsError error={needs.error} onRetry={needs.refetch} />}
      {!live.length ? (
        <p className="rounded-md border border-dashed border-border-strong px-3 py-3 text-center text-sm text-muted-foreground">
          {t(review ? 'content.files.noReview' : 'content.files.empty')}
        </p>
      ) : (
        <ul className={list ? listClass : 'grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-x-2 gap-y-2.5'}>
          {live.map((f) => <FileCard key={f.material.id} row={f} list={list} />)}
        </ul>
      )}
      {erased.length > 0 && (
        <div className="text-sm">
          <button
            type="button"
            aria-expanded={showErased}
            onClick={() => setShowErased((v) => !v)}
            className="inline-flex min-h-8 items-center gap-1 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown aria-hidden="true" className={cn('h-4 w-4 transition-transform', !showErased && '-rotate-90')} />
            {t('content.files.erased', { count: erased.length })}
          </button>
          {showErased && <ul className={listClass}>{erased.map((f) => <FileCard key={f.material.id} row={f} list />)}</ul>}
        </div>
      )}
    </section>
  );
}

/** One of the folder's "Eksikler" in a line: a çekim listesi request, or a capture a content asked for. */
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
  const small = 'h-7 px-2.5';
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1 border-b border-border px-3 py-1.5 last:border-b-0 sm:grid-cols-[1rem_minmax(0,1fr)_auto]">
      <span aria-hidden="true" className={cn('grid h-4 w-4 place-items-center rounded border-[1.5px]', need.status === 'done' ? 'border-primary bg-primary text-primary-foreground' : need.status === 'dismissed' ? 'border-border-strong bg-surface-muted' : 'border-border-strong')}>
        {need.status === 'done' && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <p className={cn('line-clamp-2 min-w-0 flex-[1_1_14rem] break-words text-sm', !open && 'text-muted-foreground line-through')} title={need.text}>{need.text}</p>
        <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
          <span>{t(shoot ? 'content.needs.shoot' : 'content.needs.material')}</span>
          {need.project_id && (
            <span>
              · {t('content.needs.askedBy')}{' '}
              <Link className="text-primary underline" to={placeHref({ olay: folder, content: need.project_id })}>{need.project_title ?? t('content.detail.label')}</Link>
            </span>
          )}
          <span>· {areaTime(need.created_at, i18n.language)}</span>
          {need.status !== 'open' && <span>· {t(`content.needs.status.${need.status}`)}</span>}
        </p>
        <MaterialsError error={resolve.error ?? dismiss.error} />
      </div>
      {open && can && (
        <div className="col-start-2 flex flex-wrap gap-1.5 sm:col-start-auto sm:justify-end">
          {uploads && (
            <Button size="sm" variant="outline" className={small} onClick={uploads.pick}>
              <Upload aria-hidden="true" className="h-4 w-4" />
              {t('content.upload.button')}
            </Button>
          )}
          {shoot && <Button size="sm" variant="outline" className={small} loading={resolve.isPending && resolve.variables === 'done'} disabled={resolve.isPending} onClick={() => resolve.mutate('done')}>{t('materials.shoot.done')}</Button>}
          <Button size="sm" variant="ghost" className={small} loading={shoot ? resolve.isPending && resolve.variables === 'dismissed' : dismiss.isPending} disabled={resolve.isPending || dismiss.isPending} onClick={() => (shoot ? resolve.mutate('dismissed') : dismiss.mutate(undefined))}>
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
      className="space-y-1 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!add.isPending && text.trim()) add.mutate(text.trim());
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-0 flex-[1_1_16rem]">
          <span className="sr-only">{t('materials.shoot.add')}</span>
          <input className={cn(fieldClass, 'sm:min-h-9 sm:py-1.5')} placeholder={t('materials.shoot.add')} maxLength={500} value={text} onChange={(e) => { setText(e.target.value); requestKey.current = null; }} />
        </label>
        <Button type="submit" size="sm" loading={add.isPending} disabled={!text.trim()}>{t('materials.shoot.addSubmit')}</Button>
      </div>
      <MaterialsError error={add.error} />
    </form>
  );
}

/** Above this many, the rest of the "Eksikler" wait behind one line. */
const NEEDS_SHOWN = 3;

function Needs({ needs, folder, materialsWork, contentWork }: { needs: Need[]; folder: string; materialsWork: boolean; contentWork: boolean }) {
  const { t } = useTranslation();
  const location = useLocation();
  // A link to the folder's "Eksikler" ("Eksiklere git") comes for one of them: all are shown.
  const [all, setAll] = useState(location.hash === '#eksikler');
  useEffect(() => { if (location.hash === '#eksikler') setAll(true); }, [location.hash]);
  const open = needs.filter((n) => n.status === 'open').length;
  const shown = all ? needs : needs.slice(0, NEEDS_SHOWN);
  const adds = folder === GENEL && materialsWork;
  return (
    <section id="eksikler" aria-labelledby="eksikler-title" className="scroll-mt-4 space-y-2">
      <SectionHead
        id="eksikler-title"
        title={t('content.needs.title')}
        count={needs.length ? t('content.needs.open', { count: open }) : undefined}
        note={!needs.length && <span className="text-sm text-muted-foreground">{t('content.needs.empty')}</span>}
      />
      {(needs.length > 0 || adds) && (
        <div className="overflow-hidden rounded-md border border-border bg-surface">
          {needs.length > 0 && <ul>{shown.map((n) => <NeedRow key={`${n.kind}-${n.id}`} need={n} folder={folder} materialsWork={materialsWork} contentWork={contentWork} />)}</ul>}
          {needs.length > NEEDS_SHOWN && (
            <button
              type="button"
              aria-expanded={all}
              onClick={() => setAll((v) => !v)}
              className="flex min-h-8 w-full items-center gap-1 border-t border-border px-3 text-start text-sm text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <ChevronDown aria-hidden="true" className={cn('h-4 w-4 transition-transform', all && 'rotate-180')} />
              {all ? t('content.needs.less') : t('content.needs.more', { count: needs.length - NEEDS_SHOWN })}
            </button>
          )}
          {adds && <div className={cn(needs.length > 0 && 'border-t border-border')}><AddShoot /></div>}
        </div>
      )}
    </section>
  );
}

/** The olay's notes, two lines unless the person asks for the rest. */
function Notes({ text }: { text: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <div className="mt-1 text-sm">
      <p ref={ref} className={cn('whitespace-pre-wrap', !open && 'line-clamp-2')}>{text}</p>
      {(long || open) && (
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="text-xs text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t(open ? 'content.olay.less' : 'content.olay.more')}
        </button>
      )}
    </div>
  );
}

/**
 * One olay as a folder, or Genel: what it is, its contents as production lines, its files, and
 * its "Eksikler". `contents` and `files` are left out for a session without their permission,
 * as the server leaves them out.
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
  // A file nobody gave a share permission is used by no content: the system waits for a person.
  const unshared = data?.files?.filter((f) => !f.material.share && !f.material.erased_at).length ?? 0;
  // A link to the folder's "Eksikler" lands on them once they are drawn.
  useEffect(() => {
    if (data && location.hash === '#eksikler') document.getElementById('eksikler')?.scrollIntoView?.({ block: 'start' });
  }, [data, location.hash]);
  const toggle = (areaId: string) =>
    place.content === areaId ? go({ ...place, content: undefined }, { replace: true }) : go({ ...place, content: areaId });
  return (
    <section aria-label={olay?.title ?? t('content.genel')} className="min-w-0 space-y-4">
      <QueryState query={view} keepOnError>
        {data && (
          <>
            <header className="flex flex-wrap items-start gap-3">
              <Folder aria-hidden="true" className="h-8 w-8 shrink-0 fill-surface-muted text-muted-foreground" strokeWidth={1.2} />
              <div className="min-w-0 flex-[1_1_15rem]">
                <h2 className="flex flex-wrap items-center gap-2 text-xl font-medium">
                  <span className="min-w-0 break-words">{olay ? olay.title : t('content.genel')}</span>
                  {olay?.status === 'proposed' ? <Badge tone="primary">{t('content.olay.proposed')}</Badge>
                    : olay ? <Badge tone={olay.ends_on < m.istanbulDay(new Date()) ? 'neutral' : 'success'}>{t(olay.ends_on < m.istanbulDay(new Date()) ? 'content.olay.ended' : 'content.olay.active')}</Badge>
                      : <Badge>{t('content.olay.always')}</Badge>}
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {olay ? <>{t(`materials.kind.${olay.kind}`)} · {formatRange(olay.starts_on, olay.ends_on, i18n.language)}{olay.place ? ` · ${olay.place}` : ''}</> : t('content.genelHelp')}
                  {olay?.client?.organization && <> · {t('materials.olay.organization')}: {olay.client.organization}</>}
                </p>
                {olay?.notes && <Notes text={olay.notes} />}
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
            {contents && (
              <section aria-labelledby="olay-contents" className="space-y-2">
                <SectionHead id="olay-contents" title={t('content.contents.title')} count={contents.length}>
                  {manage && (
                    <Button variant="outline" size="sm" onClick={() => setOpening(true)}>
                      <Plus aria-hidden="true" className="h-4 w-4" />
                      {t('contentAreas.open')}
                    </Button>
                  )}
                </SectionHead>
                {place.content && !contents.some((c) => c.area.id === place.content) && <MissingContent id={place.content} manage={manage} files={materialsWork} />}
                {contents.length ? (
                  contents.map((row) => <PipelineRow key={row.area.id} row={row} expanded={place.content === row.area.id} onToggle={() => toggle(row.area.id)} manage={manage} files={materialsWork} />)
                ) : (
                  <p className="rounded-md border border-dashed border-border-strong px-3 py-3 text-center text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">{t('content.contents.empty')}</span> · <span>{t('content.contents.emptyHelp')}</span>
                  </p>
                )}
              </section>
            )}
            {data.files && <Files files={data.files} unshared={unshared} />}
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
