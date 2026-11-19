import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ChevronDown, Clock, ExternalLink, Layers, RotateCcw, UserRound } from 'lucide-react';
import { BLOCKED_REASONS, type AreaRow, type PublicationFact, type Stage, type StageState, type TimeWait } from '@/api/content';
import { Button, cn } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { areaTime, MiniThumb, openedBy, StateBadge, stepName } from './AreaShared';
import { folderOf, placeHref } from './location';
import { AreaDetail } from './AreaDetail';

const NODE: Record<StageState, string> = {
  done: 'border-primary bg-primary text-primary-foreground',
  current: 'border-info bg-surface text-info',
  waiting_person: 'border-warning bg-warning text-warning-foreground',
  problem: 'border-danger bg-danger text-danger-foreground',
  todo: 'border-dashed border-border-strong bg-surface text-muted-foreground',
};
const LABEL: Record<StageState, string> = {
  done: 'text-foreground',
  current: 'text-info',
  waiting_person: 'text-warning',
  problem: 'text-danger',
  todo: 'font-normal text-muted-foreground',
};

/** Why no account can take a waiting version, in the words of the social page. */
export function blockedText(t: TFunction, wait: TimeWait): string {
  const reason = BLOCKED_REASONS.find((r) => r === wait.blocked);
  return reason ? t(`socialAccounts.blocked.${reason}`) : t('socialAccounts.noSuitableAccount');
}

/** Where a person gives a waiting version its account and time: its row on the social page. */
export const scheduleHref = (versionId?: string) => (versionId ? `/social?version=${encodeURIComponent(versionId)}` : '/social?filter=times');

const RETIREMENTS = ['cancelled', 'missed_grace', 'replanned', 'hypothesis_retired', 'strategy_archived', 'week_ended', 'measurements_complete'] as const;

/** A planned post's line: out, failed, taken back, due and being sent, or planned. */
export function publicationText(t: TFunction, p: PublicationFact, lang: string, short = false): string {
  const who = p.account_name ?? t('contentAreas.account');
  if (p.failed) return short ? t('content.out.failedShort') : t('content.out.failed', { account: who });
  if (p.published_at) return short ? t('content.out.publishedAt', { at: areaTime(p.published_at, lang) }) : t('content.out.published', { account: who, at: areaTime(p.published_at, lang) });
  if (p.state === 'retired') {
    const known = RETIREMENTS.find((r) => r === p.retirement) ?? 'other';
    const reason = t(`content.out.retirement.${known}`);
    return short ? reason : `${who} · ${reason}`;
  }
  if (Date.parse(p.scheduled_at) <= Date.now()) return short ? t('content.out.dueShort') : t('content.out.due', { account: who });
  return short ? t('content.out.plannedAt', { at: areaTime(p.scheduled_at, lang) }) : t('content.out.planned', { account: who, at: areaTime(p.scheduled_at, lang) });
}

export function StageNode({ state, small = false }: { state: StageState; small?: boolean }) {
  const icon = small ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5';
  return (
    <span className={cn('relative grid shrink-0 place-items-center rounded-full border-2', small ? 'h-5 w-5' : 'h-6 w-6 max-sm:h-4 max-sm:w-4 max-sm:border-[1.5px]', NODE[state])}>
      {state === 'done' && <Check aria-hidden="true" className={icon} strokeWidth={3} />}
      {state === 'waiting_person' && <UserRound aria-hidden="true" className={icon} strokeWidth={2.5} />}
      {state === 'problem' && <AlertTriangle aria-hidden="true" className={icon} strokeWidth={2.5} />}
      {state === 'current' && (
        <>
          <span className="h-2 w-2 rounded-full bg-info max-sm:h-1.5 max-sm:w-1.5" />
          <span aria-hidden="true" className="absolute -inset-1 rounded-full border-2 border-info opacity-40 motion-safe:animate-ping" />
        </>
      )}
    </span>
  );
}

/** The stage the row speaks about on a phone: the first not finished, else the last. */
export function focusIndex(stages: Stage[]): number {
  const open = stages.findIndex((s) => s.state === 'current' || s.state === 'waiting_person' || s.state === 'problem');
  if (open >= 0) return open;
  const firstTodo = stages.findIndex((s) => s.state === 'todo');
  return firstTodo === 0 ? 0 : firstTodo > 0 ? firstTodo - 1 : stages.length - 1;
}

/**
 * What a stage produced, as the server reports it, under its node: the steps' one-line outputs,
 * the chosen materials, the package's versions, the planned posts' approvals and times, and the
 * last measurement's numbers. A stage that produced nothing shows nothing; a stage that waits
 * says for whom.
 */
export function StageOutput({ stage, row, files }: { stage: Stage; row: AreaRow; files: boolean }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  if (stage.state === 'todo') return null;
  const lines: ReactNode[] = [];
  const outputs = (stage.steps ?? []).filter((s) => s.output).map((s) => s.output!);
  if (stage.key === 'gorsel') {
    const ids = [...new Set((stage.steps ?? []).flatMap((s) => s.material_ids ?? []))];
    if (ids.length)
      lines.push(
        <span key="materials" className="flex flex-wrap items-center gap-1">
          {ids.slice(0, 3).map((id) => <MiniThumb key={id} id={id} files={files} />)}
          {ids.length > 3 && <span className="font-mono text-micro">+{ids.length - 3}</span>}
        </span>,
      );
  }
  if (stage.span && stage.key !== 'gorsel' && outputs.length)
    lines.push(<span key="outputs" className="line-clamp-3 text-foreground">{outputs.join(' · ')}</span>);
  if (stage.package)
    lines.push(
      <span key="package" className="flex flex-wrap gap-1">
        {stage.package.versions.map((v) => (
          <span key={v.id} className="rounded border border-primary/40 bg-primary/10 px-1.5 text-micro text-primary">
            {t(`posts.format.${v.format}`)}
          </span>
        ))}
      </span>,
    );
  for (const a of stage.approvals ?? []) {
    if (a.waiting) continue;
    if (a.approved_at) lines.push(<span key={`a-${a.slot_id}`}>{t('content.out.approved', { at: areaTime(a.approved_at, lang) })}</span>);
    else if (!a.required) lines.push(<span key={`a-${a.slot_id}`}>{t('content.out.noApproval')}</span>);
  }
  for (const p of stage.publications ?? []) {
    lines.push(
      <span key={`p-${p.slot_id}`} className={cn('block', p.failed && 'font-medium text-danger')}>
        {publicationText(t, p, lang)}
      </span>,
    );
  }
  // The finished package's versions with no time yet: waiting for one, or blocked.
  const unscheduled = row.pipeline.unscheduled ?? [];
  if (stage.key === 'onay' && stage.state === 'current' && unscheduled.length)
    lines.push(<span key="time" className="block text-info">{t('content.out.awaitsTime', { count: unscheduled.length })}</span>);
  if (stage.key === 'yayin')
    for (const w of unscheduled.filter((x) => x.blocked))
      lines.push(<span key={`b-${w.version_id}`} className="block font-medium text-danger">{t('content.out.blocked', { format: t(`posts.format.${w.format}`) })}</span>);
  for (const r of stage.results ?? []) {
    const numbers = Object.entries(r.metrics).filter(([, v]) => v !== null) as [string, number][];
    if (numbers.length)
      lines.push(
        <span key={`r-${r.publication_id}`} className="flex flex-wrap gap-x-3 gap-y-1">
          {numbers.slice(0, 3).map(([k, v]) => (
            <span key={k} className="flex flex-col leading-tight">
              <b className="text-sm font-medium text-foreground">{formatNumber(v, lang)}</b>
              <small className="text-micro">{t(`content.metric.${k}`, { defaultValue: k })}</small>
            </span>
          ))}
        </span>,
      );
  }
  if (stage.state === 'current' && stage.span && row.pipeline.current_step && row.pipeline.current_step >= stage.span[0] && row.pipeline.current_step <= stage.span[1])
    lines.push(<span key="now" className="block text-info">{stepName(t, row.pipeline.current_step)}</span>);
  if (stage.state === 'waiting_person')
    lines.push(
      <span key="wait" className="block font-medium text-warning">
        {stage.key === 'onay' ? t('content.out.awaitsApproval') : row.area.open_requests ? t('contentAreas.waiting', { n: row.area.open_requests }) : t('content.out.awaitsPerson')}
      </span>,
    );
  if (stage.state === 'problem' && !(stage.publications ?? []).some((p) => p.failed) && !(stage.key === 'yayin' && unscheduled.some((x) => x.blocked)))
    lines.push(<span key="problem" className="block font-medium text-danger">{t('content.out.stuck')}</span>);
  if (!lines.length) return null;
  return <div className="min-w-0 space-y-1 pe-3 text-xs leading-snug text-muted-foreground">{lines}</div>;
}

/** The one thing under a track that asks a person for something, pointing at its stage. */
function ExceptionBar({ row, onExpand, expanded }: { row: AreaRow; onExpand: () => void; expanded: boolean }) {
  const { t, i18n } = useTranslation();
  const stages = row.pipeline.stages;
  const index = stages.findIndex((s) => s.state === 'problem');
  const waiting = stages.findIndex((s) => s.state === 'waiting_person');
  const at = index >= 0 ? index : waiting;
  const stage = at >= 0 ? stages[at] : undefined;
  const folder = placeHref({ olay: folderOf(row.area.olay_id) });
  const preview = !expanded && <Button size="sm" variant="ghost" onClick={onExpand}>{t('content.row.preview')}</Button>;
  let tone: 'warning' | 'danger' | 'neutral' = 'neutral';
  let title: ReactNode = null;
  let body: ReactNode = null;
  let actions: ReactNode = null;
  const unscheduled = row.pipeline.unscheduled ?? [];
  const blocked = unscheduled.filter((w) => w.blocked);
  if (stage?.state === 'problem') {
    tone = 'danger';
    const failed = (stage.publications ?? []).filter((p) => p.failed);
    const cannotTime = stage.key === 'yayin' && blocked.length > 0;
    title = cannotTime && !failed.length
      ? t('content.bar.blocked', { count: blocked.length })
      : t(stage.key === 'yayin' ? 'content.bar.publishFailed' : 'content.bar.problem', { stage: t(`content.stage.${stage.key}`) });
    body = stage.key === 'paket'
      ? t('contentAreas.held')
      : cannotTime ? [...new Set(blocked.map((w) => blockedText(t, w)))].join(' ') : null;
    actions = <>
      {failed.map((p) => <Button key={p.slot_id} size="sm" variant="outline" asChild><Link to={`/social?slot=${encodeURIComponent(p.slot_id)}`}>{t('content.bar.openPost', { account: p.account_name ?? t('contentAreas.account') })}</Link></Button>)}
      {cannotTime && <Button size="sm" variant="outline" asChild><Link to={scheduleHref(blocked[0].version_id)}>{t('content.bar.toSocial')}</Link></Button>}
      {!expanded && <Button size="sm" variant="outline" onClick={onExpand}>{t('content.bar.inspect')}</Button>}
    </>;
  } else if (stage?.state === 'waiting_person' && stage.key === 'onay') {
    tone = 'warning';
    title = t('content.out.awaitsApproval');
    const names = new Map((stages.find((s) => s.key === 'yayin')?.publications ?? []).map((p) => [p.slot_id, p]));
    actions = <>
      {(stage.approvals ?? []).filter((a) => a.waiting).map((a) => {
        const p = names.get(a.slot_id);
        return <Button key={a.slot_id} size="sm" asChild><Link to={`/social?slot=${encodeURIComponent(a.slot_id)}`}><Check aria-hidden="true" className="h-4 w-4" />{p ? t('content.bar.approveAt', { account: p.account_name ?? t('contentAreas.account'), at: areaTime(p.scheduled_at, i18n.language) }) : t('content.bar.approve')}</Link></Button>;
      })}
      {preview}
    </>;
  } else if (stage?.state === 'waiting_person') {
    tone = 'warning';
    title = row.area.open_requests ? t('contentAreas.waiting', { n: row.area.open_requests }) : t('content.out.awaitsPerson');
    actions = <>
      <Button size="sm" variant="outline" asChild><Link to={`${folder}#eksikler`}>{t('content.bar.toNeeds')}</Link></Button>
      {preview}
    </>;
  } else if (unscheduled.some((w) => !w.blocked)) {
    // Finished, with versions that have no time: the agent gives them on its next run; a person
    // who does not want to wait gives them on the social page.
    const first = unscheduled.find((w) => !w.blocked)!;
    title = t('content.bar.awaitsTime', { count: unscheduled.filter((w) => !w.blocked).length });
    body = t('content.bar.awaitsTimeHelp');
    actions = <>
      <Button size="sm" variant="outline" asChild><Link to={scheduleHref(first.version_id)}>{t('content.bar.giveTime')}</Link></Button>
      {preview}
    </>;
  } else if (row.area.redo) {
    title = t('contentAreas.redoStatus', { note: row.area.redo.note });
  } else if (row.area.status.state === 'queued' && Date.parse(row.area.status.starts_at) > Date.now()) {
    title = t('content.bar.startsAt', { at: areaTime(row.area.status.starts_at, i18n.language) });
  } else return null;
  const Icon = tone === 'danger' ? AlertTriangle : tone === 'warning' ? UserRound : row.area.redo ? RotateCcw : Clock;
  return (
    <div
      className={cn(
        'mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2',
        tone === 'danger' ? 'border-danger/50 bg-danger-subtle' : tone === 'warning' ? 'border-warning/50 bg-warning-subtle' : 'border-border bg-surface-muted',
      )}
      data-stage={stage?.key}
    >
      <div className="min-w-0 flex-[1_1_16rem] text-sm">
        <p className={cn('flex items-center gap-1.5 font-medium', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-foreground')}>
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{title}</span>
        </p>
        {body && <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** The current package's first material, or a step's, to show the content by. */
function coverOf(row: AreaRow): string | undefined {
  const pkg = row.pipeline.stages.find((s) => s.key === 'paket')?.package;
  return pkg?.versions.flatMap((v) => v.material_ids)[0] ?? row.pipeline.stages.flatMap((s) => s.steps ?? []).flatMap((s) => s.material_ids ?? [])[0];
}

/**
 * One content as its production line: eight stages, each with its state from the server and,
 * finished, what it produced; under the track the one thing that waits for a person. Opening it
 * shows the fourteen steps and the package's versions in a phone frame.
 */
export function PipelineRow({
  row,
  expanded,
  onToggle,
  manage,
  files,
}: {
  row: AreaRow;
  expanded: boolean;
  onToggle: () => void;
  manage: boolean;
  /** The session reads files (`materials.work`): thumbnails and the file drawer. */
  files: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { area, pipeline } = row;
  const stages = pipeline.stages;
  const focus = focusIndex(stages);
  const allDone = stages.every((s) => s.state === 'done');
  const problem = stages.some((s) => s.state === 'problem');
  const waits = stages.some((s) => s.state === 'waiting_person');
  const cover = coverOf(row);
  const panel = `content-${area.id}-detail`;
  const stepText = pipeline.current_step && !stages.slice(0, 5).every((s) => s.state === 'done')
    ? t('content.row.step', { n: pipeline.current_step })
    : stages.slice(0, 5).every((s) => s.state === 'done') ? t('content.row.stepsDone') : null;
  return (
    <article
      id={`content-${area.id}`}
      aria-label={area.title}
      className={cn(
        'min-w-0 scroll-mt-4 rounded-lg border bg-surface shadow-xs',
        problem ? 'border-danger/50' : waits ? 'border-warning/50' : 'border-border',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panel}
        onClick={onToggle}
        className="grid w-full grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-3 rounded-t-lg px-4 pb-2 pt-3 text-start hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[2.75rem_minmax(0,1fr)_auto_1.25rem]"
      >
        {cover ? <MiniThumb id={cover} size="h-11 w-11" files={false} /> : <span className="flex h-11 w-11 items-center justify-center rounded bg-surface-muted"><Layers aria-hidden="true" className="h-5 w-5 text-muted-foreground" /></span>}
        <span className="min-w-0">
          <span className="block truncate font-medium">{area.title}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{openedBy(t, area.opened_by)}</span>
            {!allDone && <span>{areaTime(area.status.starts_at, i18n.language)}</span>}
            {stepText && <span className="font-mono">{stepText}</span>}
          </span>
        </span>
        <StateBadge state={area.status.state} />
        <ChevronDown aria-hidden="true" className={cn('hidden h-5 w-5 text-muted-foreground transition-transform sm:block', expanded && 'rotate-180')} />
      </button>
      <div className="overflow-x-auto px-4 pb-3 max-sm:overflow-visible">
        <ol aria-label={t('content.row.stages')} className="grid min-w-[52rem] grid-cols-8 max-sm:min-w-0">
          {stages.map((stage, i) => (
            <li key={stage.key} className="flex min-w-0 flex-col gap-1.5" aria-current={i === focus && !allDone ? 'step' : undefined}>
              <div className="flex h-7 items-center max-sm:h-5">
                <StageNode state={stage.state} />
                {i < stages.length - 1 && (
                  <span aria-hidden="true" className={cn('mx-1.5 h-0.5 flex-1 rounded max-sm:mx-0.5', stage.state === 'done' ? 'bg-primary' : 'bg-[repeating-linear-gradient(90deg,var(--border-strong)_0_4px,transparent_4px_8px)]')} />
                )}
              </div>
              <p className={cn('whitespace-nowrap text-xs font-medium', LABEL[stage.state], i !== focus && 'max-sm:sr-only', i === focus && i > 4 && 'max-sm:-ms-[200%] max-sm:w-[300%] max-sm:text-end')}>
                {t(`content.stage.${stage.key}`)}
                <span className="sr-only">: {t(`content.stageState.${stage.state}`)}</span>
              </p>
              <div className="max-sm:hidden">
                <StageOutput stage={stage} row={row} files={files} />
              </div>
            </li>
          ))}
        </ol>
        <div className="sm:hidden">
          {stages[focus] && (
            <div className="mt-2 rounded bg-surface-muted px-3 py-2 empty:hidden">
              <StageOutput stage={stages[focus]} row={row} files={files} />
            </div>
          )}
        </div>
        <ExceptionBar row={row} expanded={expanded} onExpand={onToggle} />
      </div>
      {expanded && (
        <div id={panel} className="border-t border-border bg-surface-muted/40 px-4 py-4">
          <AreaDetail id={area.id} row={row} manage={manage} files={files} />
        </div>
      )}
    </article>
  );
}

/** A publication's link, when the post went out and has one. */
export function PostLink({ url }: { url: string | null }) {
  const { t } = useTranslation();
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">
      {t('content.out.link')}
      <ExternalLink aria-hidden="true" className="h-3 w-3" />
    </a>
  );
}
