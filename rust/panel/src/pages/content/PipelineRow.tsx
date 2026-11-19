import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, ChevronDown, Clock, ExternalLink, RotateCcw, UserRound } from 'lucide-react';
import { BLOCKED_REASONS, type AreaRow, type PublicationFact, type Stage, type StageState, type TimeWait, type VersionCancel } from '@/api/content';
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

/** A person's cancellation of the post `slotId`, as the versions of a package carry it. */
export function cancelOf(versions: { cancelled?: VersionCancel }[] | undefined, slotId: string): VersionCancel | undefined {
  return versions?.find((v) => v.cancelled?.slot_id === slotId)?.cancelled;
}

/**
 * A planned post's line: out, failed, taken back (a person's cancel with its reason, `cancel`),
 * due and being sent, or planned.
 */
export function publicationText(t: TFunction, p: PublicationFact, lang: string, short = false, cancel?: VersionCancel): string {
  const who = p.account_name ?? t('contentAreas.account');
  if (p.failed && !cancel) return short ? t('content.out.failedShort') : t('content.out.failed', { account: who });
  if (p.published_at) return short ? t('content.out.publishedAt', { at: areaTime(p.published_at, lang) }) : t('content.out.published', { account: who, at: areaTime(p.published_at, lang) });
  if (p.state === 'retired') {
    const known = RETIREMENTS.find((r) => r === p.retirement) ?? 'other';
    const reason = cancel ? t('content.out.cancelled', { reason: cancel.reason }) : t(`content.out.retirement.${known}`);
    return short ? reason : `${who} · ${reason}`;
  }
  if (Date.parse(p.scheduled_at) <= Date.now()) return short ? t('content.out.dueShort') : t('content.out.due', { account: who });
  return short ? t('content.out.plannedAt', { at: areaTime(p.scheduled_at, lang) }) : t('content.out.planned', { account: who, at: areaTime(p.scheduled_at, lang) });
}

export function StageNode({ state, small = false }: { state: StageState; small?: boolean }) {
  const icon = small ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5';
  return (
    <span className={cn('relative grid shrink-0 place-items-center rounded-full border-2', small ? 'h-5 w-5 max-sm:h-4 max-sm:w-4' : 'h-6 w-6 max-sm:h-4 max-sm:w-4 max-sm:border-[1.5px]', NODE[state])}>
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

/** A phrase of what a stage produced or waits for; `state` ones repeat what the row's bar says. */
export interface StageFact {
  text: string;
  tone?: 'info' | 'warning' | 'danger';
  state?: boolean;
}

/**
 * What a stage produced, as the server reports it, in short phrases: the steps' one-line outputs,
 * the package's versions, the planned posts' approvals and times, the last measurement's
 * numbers; and, while it runs or waits, its step or for whom. A stage still to do has none.
 */
export function stageFacts(t: TFunction, stage: Stage, row: AreaRow, lang: string): StageFact[] {
  if (stage.state === 'todo') return [];
  const facts: StageFact[] = [];
  if (stage.state === 'current' && stage.span && row.pipeline.current_step && row.pipeline.current_step >= stage.span[0] && row.pipeline.current_step <= stage.span[1])
    facts.push({ text: stepName(t, row.pipeline.current_step), tone: 'info' });
  if (stage.span) for (const s of stage.steps ?? []) if (s.output) facts.push({ text: s.output });
  if (stage.package) facts.push({ text: stage.package.versions.map((v) => t(`posts.format.${v.format}`)).join(', ') });
  for (const a of stage.approvals ?? []) {
    if (a.waiting) continue;
    if (a.approved_at) facts.push({ text: t('content.out.approved', { at: areaTime(a.approved_at, lang) }) });
    else if (!a.required) facts.push({ text: t('content.out.noApproval') });
  }
  const versions = row.pipeline.stages.find((s) => s.key === 'paket')?.package?.versions;
  for (const p of stage.publications ?? []) {
    const cancel = cancelOf(versions, p.slot_id);
    const failed = p.failed && !cancel;
    facts.push({ text: publicationText(t, p, lang, false, cancel), tone: failed ? 'danger' : undefined, state: failed });
  }
  // The finished package's versions with no time yet: waiting for one, or blocked.
  const unscheduled = row.pipeline.unscheduled ?? [];
  if (stage.key === 'onay' && stage.state === 'current' && unscheduled.length)
    facts.push({ text: t('content.out.awaitsTime', { count: unscheduled.length }), tone: 'info', state: true });
  if (stage.key === 'yayin')
    for (const w of unscheduled.filter((x) => x.blocked)) facts.push({ text: t('content.out.blocked', { format: t(`posts.format.${w.format}`) }), tone: 'danger', state: true });
  for (const r of stage.results ?? []) {
    const numbers = Object.entries(r.metrics).filter(([, v]) => v !== null) as [string, number][];
    if (numbers.length) facts.push({ text: numbers.slice(0, 3).map(([k, v]) => `${formatNumber(v, lang)} ${t(`content.metric.${k}`, { defaultValue: k })}`).join(' · ') });
  }
  if (stage.state === 'waiting_person')
    facts.push({ text: stage.key === 'onay' ? t('content.out.awaitsApproval') : row.area.open_requests ? t('contentAreas.waiting', { n: row.area.open_requests }) : t('content.out.awaitsPerson'), tone: 'warning', state: true });
  if (stage.state === 'problem' && !(stage.publications ?? []).some((p) => p.failed) && !(stage.key === 'yayin' && unscheduled.some((x) => x.blocked)))
    facts.push({ text: t('content.out.stuck'), tone: 'danger', state: true });
  return facts;
}

/** Whether the row has a line under its track that asks a person for something or says why it waits. */
function barShows(row: AreaRow): boolean {
  const { stages, unscheduled = [] } = row.pipeline;
  return stages.some((s) => s.state === 'problem' || s.state === 'waiting_person')
    || unscheduled.some((w) => !w.blocked)
    || !!row.area.redo
    || (row.area.status.state === 'queued' && Date.parse(row.area.status.starts_at) > Date.now());
}

/** The one thing under a track that asks a person for something, as one line pointing at its stage. */
function ExceptionBar({ row, onExpand, expanded }: { row: AreaRow; onExpand: () => void; expanded: boolean }) {
  const { t, i18n } = useTranslation();
  const stages = row.pipeline.stages;
  const index = stages.findIndex((s) => s.state === 'problem');
  const waiting = stages.findIndex((s) => s.state === 'waiting_person');
  const at = index >= 0 ? index : waiting;
  const stage = at >= 0 ? stages[at] : undefined;
  const folder = placeHref({ olay: folderOf(row.area.olay_id) });
  const small = 'h-7 px-2.5';
  // On a phone the row's own line opens it; the bar keeps to what asks for the person.
  const preview = !expanded && <Button size="sm" variant="ghost" className={cn(small, 'max-sm:hidden')} onClick={onExpand}>{t('content.row.preview')}</Button>;
  let tone: 'warning' | 'danger' | 'neutral' = 'neutral';
  let title = '';
  let body: string | null = null;
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
      {failed.map((p) => <Button key={p.slot_id} size="sm" variant="outline" className={small} asChild><Link to={`/social?slot=${encodeURIComponent(p.slot_id)}`}>{t('content.bar.openPost', { account: p.account_name ?? t('contentAreas.account') })}</Link></Button>)}
      {cannotTime && <Button size="sm" variant="outline" className={small} asChild><Link to={scheduleHref(blocked[0].version_id)}>{t('content.bar.toSocial')}</Link></Button>}
      {!expanded && <Button size="sm" variant="outline" className={small} onClick={onExpand}>{t('content.bar.inspect')}</Button>}
    </>;
  } else if (stage?.state === 'waiting_person' && stage.key === 'onay') {
    tone = 'warning';
    title = t('content.out.awaitsApproval');
    const names = new Map((stages.find((s) => s.key === 'yayin')?.publications ?? []).map((p) => [p.slot_id, p]));
    actions = <>
      {(stage.approvals ?? []).filter((a) => a.waiting).map((a) => {
        const p = names.get(a.slot_id);
        return <Button key={a.slot_id} size="sm" className={small} asChild><Link to={`/social?slot=${encodeURIComponent(a.slot_id)}`}><Check aria-hidden="true" className="h-4 w-4" />{p ? t('content.bar.approveAt', { account: p.account_name ?? t('contentAreas.account'), at: areaTime(p.scheduled_at, i18n.language) }) : t('content.bar.approve')}</Link></Button>;
      })}
      {preview}
    </>;
  } else if (stage?.state === 'waiting_person') {
    tone = 'warning';
    title = row.area.open_requests ? t('contentAreas.waiting', { n: row.area.open_requests }) : t('content.out.awaitsPerson');
    actions = <>
      <Button size="sm" variant="outline" className={small} asChild><Link to={`${folder}#eksikler`}>{t('content.bar.toNeeds')}</Link></Button>
      {preview}
    </>;
  } else if (unscheduled.some((w) => !w.blocked)) {
    // Finished, with versions that have no time: the agent gives them on its next run; a person
    // who does not want to wait gives them on the social page.
    const first = unscheduled.find((w) => !w.blocked)!;
    title = t('content.bar.awaitsTime', { count: unscheduled.filter((w) => !w.blocked).length });
    body = t('content.bar.awaitsTimeHelp');
    actions = <>
      <Button size="sm" variant="outline" className={small} asChild><Link to={scheduleHref(first.version_id)}>{t('content.bar.giveTime')}</Link></Button>
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
        'mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1',
        tone === 'danger' ? 'border-danger/50 bg-danger-subtle' : tone === 'warning' ? 'border-warning/50 bg-warning-subtle' : 'border-border bg-surface-muted',
      )}
      data-stage={stage?.key}
    >
      <Icon aria-hidden="true" className={cn('h-4 w-4 shrink-0', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-muted-foreground')} />
      {/* One line while the row is closed (two on a phone); opened, the whole of it. */}
      <p className={cn('min-w-0 flex-[1_1_12rem] text-sm', !expanded && 'max-sm:line-clamp-2 sm:truncate')} title={body ? `${title} · ${body}` : title}>
        <span className={cn('font-medium', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-foreground')}>{title}</span>
        {body && <span className="text-muted-foreground"> · {body}</span>}
      </p>
      {actions && <div className="flex flex-wrap gap-1.5">{actions}</div>}
    </div>
  );
}

const TONE_TEXT = { info: 'text-info', warning: 'font-medium text-warning', danger: 'font-medium text-danger' } as const;

/** The focused stage's one line: the visual stage's pictures, small, then its phrases. */
function FocusLine({ stage, facts, files, className }: { stage: Stage; facts: StageFact[]; files: boolean; className?: string }) {
  const ids = stage.key === 'gorsel' ? [...new Set((stage.steps ?? []).flatMap((s) => s.material_ids ?? []))] : [];
  if (!facts.length && !ids.length) return null;
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground', className)}>
      {ids.length > 0 && (
        <span className="flex shrink-0 items-center gap-0.5">
          {ids.slice(0, 3).map((id) => <MiniThumb key={id} id={id} size="h-5 w-5" files={files} />)}
          {ids.length > 3 && <span className="font-mono text-micro">+{ids.length - 3}</span>}
        </span>
      )}
      {facts.length > 0 && (
        <span aria-hidden="true" className="min-w-0 truncate" title={facts.map((f) => f.text).join(' · ')}>
          {facts.map((f, i) => (
            <span key={i} className={f.tone ? TONE_TEXT[f.tone] : 'text-foreground'}>
              {i > 0 && <span className="text-muted-foreground"> · </span>}
              {f.text}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * One content as its production line, compact: a line with its title, who opened it, when and
 * its state; the eight stages as one slim track, where only the stage it stands at says what it
 * produced or does (every stage's phrases are in its accessible name, and the opened row lists
 * all fourteen steps); and under the track, in one line, the one thing that waits for a person.
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
  const lang = i18n.language;
  const { area, pipeline } = row;
  const stages = pipeline.stages;
  const focus = focusIndex(stages);
  const allDone = stages.every((s) => s.state === 'done');
  const problem = stages.some((s) => s.state === 'problem');
  const waits = stages.some((s) => s.state === 'waiting_person');
  const bar = barShows(row);
  const panel = `content-${area.id}-detail`;
  const stepText = pipeline.current_step && !stages.slice(0, 5).every((s) => s.state === 'done')
    ? t('content.row.step', { n: pipeline.current_step })
    : stages.slice(0, 5).every((s) => s.state === 'done') ? t('content.row.stepsDone') : null;
  const meta = [openedBy(t, area.opened_by), !allDone ? areaTime(area.status.starts_at, lang) : '', stepText ?? ''].filter(Boolean).join(' · ');
  const facts = stages.map((s) => stageFacts(t, s, row, lang));
  // What the bar under the track says is not said again on the track.
  const focusFacts = (facts[focus] ?? []).filter((f) => !(bar && f.state));
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
        className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-t-lg px-3 pb-1 pt-2 text-start hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex-nowrap"
      >
        <span className="min-w-0 flex-[1_1_0%] truncate font-medium sm:flex-[0_1_auto]">{area.title}</span>
        <span className="min-w-0 flex-[0_1000_auto] truncate text-xs text-muted-foreground max-sm:order-last max-sm:basis-full">{meta}</span>
        <span className="ms-auto flex shrink-0 items-center gap-1.5">
          <StateBadge state={area.status.state} />
          <ChevronDown aria-hidden="true" className={cn('h-4 w-4 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
        </span>
      </button>
      <div className="px-3 pb-2">
        <ol aria-label={t('content.row.stages')} className="flex min-w-0 items-center gap-0.5 sm:gap-1">
          {stages.map((stage, i) => {
            const isFocus = i === focus;
            const said = facts[i].map((f) => f.text).join(' · ');
            return (
              <li
                key={stage.key}
                aria-current={isFocus && !allDone ? 'step' : undefined}
                className={cn('flex items-center gap-1', isFocus ? 'flex-[0_1_auto] max-sm:min-w-fit sm:min-w-0' : 'min-w-0 flex-[1_1_auto]')}
              >
                <StageNode state={stage.state} small />
                <span data-stage-label className={cn('shrink-0 whitespace-nowrap text-xs font-medium', LABEL[stage.state], !isFocus && 'max-sm:sr-only')}>
                  {t(`content.stage.${stage.key}`)}
                  <span className="sr-only">: {t(`content.stageState.${stage.state}`)}{said && ` · ${said}`}</span>
                </span>
                {isFocus && <FocusLine stage={stage} facts={focusFacts} files={files} className="max-sm:hidden" />}
                {i < stages.length - 1 && (
                  <span aria-hidden="true" className={cn('h-0.5 min-w-1.5 flex-1 rounded sm:min-w-2', stage.state === 'done' ? 'bg-primary' : 'bg-[repeating-linear-gradient(90deg,var(--border-strong)_0_3px,transparent_3px_6px)]')} />
                )}
              </li>
            );
          })}
        </ol>
        {stages[focus] && <FocusLine stage={stages[focus]} facts={focusFacts} files={files} className="mt-1 sm:hidden" />}
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
