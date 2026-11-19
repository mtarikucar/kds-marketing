import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Bot, CheckCircle2, ChevronDown, Clock, PauseCircle, UserRound, XCircle } from 'lucide-react';
import { claimTask, closeTask, getTask } from '@/api/research';
import type { ListedTask } from '@/api/types';
import { ErrorCallout } from '@/components/ErrorCallout';
import { Button, cn, Input, Progress, toast } from '@/components/ui';
import { formatNumber, formatRelative, formatWhen } from '@/lib/format';
import { useInFlight } from '@/lib/leads';
import { ProspectStatusBadge, recorderText, useLeadsKey, useLeadsNames, useLeadsRefresh } from '../LeadsShared';
import { useTaskCopy, type TaskCopy } from './copy';
import { briefLine, languageName, placeText, targetShare, taskName, taskState, type TaskState } from './words';

/** How many places an opened brief lists before "show all". */
const PLACES = 12;
/** How many of its newest prospects an opened task lists. */
const NEWEST = 5;
/** The note the server closes a one-off task with when its target is reached (`close_if_found`). */
const AUTO_CLOSE_NOTE = 'target reached';

/** A task's state as one short line with its icon and tone. */
function StateLine({ state, who, quietWaiting }: { state: TaskState; who: (s: Extract<TaskState, { kind: 'held' }>) => string; quietWaiting?: boolean }) {
  const copy = useTaskCopy();
  const when = (at: string | null) => formatWhen(at, copy.language);
  let text: string;
  let Icon = Clock;
  let tone = 'text-muted-foreground';
  switch (state.kind) {
    case 'held':
      text = copy(state.by === 'you' ? 'heldByYou' : state.by === 'agent' ? 'heldByAgent' : 'heldByMember', { name: who(state), until: when(state.until) });
      Icon = state.by === 'agent' ? Bot : UserRound;
      tone = state.by === 'you' ? 'text-primary' : 'text-info';
      break;
    case 'waiting':
      // Said once above the list when the page says what the agent will do; else quietly here.
      if (quietWaiting) return null;
      text = copy('waiting');
      break;
    case 'doneToday':
      text = copy('doneToday');
      Icon = CheckCircle2;
      break;
    case 'pausedToday':
      text = copy('pausedToday');
      Icon = PauseCircle;
      break;
    case 'closed':
      text = copy(state.status === 'done' ? 'closedDone' : state.status === 'canceled' ? 'closedCanceled' : 'closedSuperseded', { when: when(state.at) });
      Icon = state.status === 'done' ? CheckCircle2 : XCircle;
      tone = state.status === 'done' ? 'text-success' : 'text-muted-foreground';
      break;
  }
  return (
    <span className={cn('flex min-w-0 items-start gap-1.5 text-xs font-medium', tone)}>
      <Icon aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </span>
  );
}

/** A group of the opened brief: a small heading and what it says. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="text-sm [overflow-wrap:anywhere]">{children}</div>
    </section>
  );
}

/** The brief, opened: what is sought and where, the signals and exclusions, size, language, pace. */
function BriefView({ item, segments, named }: { item: ListedTask; segments: ReadonlyMap<string, string>; named: boolean }) {
  const copy = useTaskCopy();
  const { brief, kind, daily_cap } = item.task;
  const [allPlaces, setAllPlaces] = useState(false);
  const places = allPlaces ? brief.areas : brief.areas.slice(0, PLACES);
  const segment = brief.segment_key ? segments.get(brief.segment_key) : undefined;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <Group title={copy('sought')}>{brief.sectors.join(', ')}</Group>
        <Group title={copy('where')}>
          <p>{places.map(placeText).join(', ')}</p>
          {brief.areas.length > PLACES && (
            <button type="button" className="mt-1 text-xs font-medium text-primary underline underline-offset-4" onClick={() => setAllPlaces((v) => !v)}>
              {allPlaces ? copy('showLess') : copy('showAll', { n: brief.areas.length })}
            </button>
          )}
        </Group>
        {item.task.status === 'open' && <p className="text-sm text-muted-foreground">
          {kind.type === 'ad_hoc' ? copy('paceOneOff', { cap: daily_cap, target: kind.target_count }) : copy('paceStanding', { cap: daily_cap })}
        </p>}
      </div>
      <div className="min-w-0 space-y-4">
        {brief.signals.length > 0 && (
          <Group title={copy('signals')}>
            <ul className="list-disc space-y-0.5 ps-4">{brief.signals.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </Group>
        )}
        {brief.exclusions.length > 0 && (
          <Group title={copy('exclusions')}>
            <ul className="list-disc space-y-0.5 ps-4">{brief.exclusions.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </Group>
        )}
        {brief.size_hint && <Group title={copy('size')}>{brief.size_hint}</Group>}
        {brief.language && <Group title={copy('language')}>{languageName(brief.language, copy.language)}</Group>}
        {segment && !named && <Group title={copy('segment')}>{segment}</Group>}
        {brief.note && <Group title={copy('note')}><p className="whitespace-pre-wrap">{brief.note}</p></Group>}
      </div>
    </div>
  );
}

/** A person's claim: two hours in their name; another holder's live claim is said, not fought. */
function Claim({ item, state, who }: { item: ListedTask; state: TaskState; who: (s: Extract<TaskState, { kind: 'held' }>) => string }) {
  const copy = useTaskCopy();
  const refresh = useLeadsRefresh();
  const claim = useMutation({
    mutationFn: () => claimTask(item.task.id),
    onSuccess: async (out) => {
      toast[out.held_by_other ? 'info' : 'success'](copy(out.held_by_other ? 'claimTaken' : 'claimed'));
      await refresh();
    },
  });
  if (state.kind === 'held' && state.by !== 'you')
    return <p className="text-sm text-muted-foreground">{copy('heldOther', { name: who(state), until: formatWhen(state.until, copy.language) })}</p>;
  const mine = state.kind === 'held';
  return (
    <div className="space-y-2">
      {!mine && <p className="max-w-prose text-sm text-muted-foreground">{copy('claimHelp')}</p>}
      <Button size="sm" variant="outline" loading={claim.isPending} onClick={() => !claim.isPending && claim.mutate()}>
        <UserRound aria-hidden="true" className="h-4 w-4" />
        {copy(mine ? 'renew' : 'claim')}
      </Button>
      {claim.error ? <ErrorCallout error={claim.error} /> : null}
    </div>
  );
}

/** Closing a one-off task, in place: an optional note and the outcome on its button. */
function Close({ item }: { item: ListedTask }) {
  const copy = useTaskCopy();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const close = useMutation({
    mutationFn: (outcome: 'done' | 'canceled') => closeTask(item.task.id, { outcome, note: note.trim() || undefined }),
    onSuccess: async () => {
      toast.success(copy('closedToast'));
      setOpen(false);
      await refresh();
    },
  });
  const run = (outcome: 'done' | 'canceled') => guard((release) => close.mutate(outcome, { onSettled: release }));
  if (!open)
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {copy('close')}
      </Button>
    );
  return (
    <form className="flex flex-wrap items-end gap-2" aria-label={copy('close')} onSubmit={(e) => e.preventDefault()}>
      <p className="basis-full text-sm text-muted-foreground">{copy('closeHelp')}</p>
      <label className="flex min-w-0 flex-[1_1_14rem] flex-col gap-1 text-sm">
        {copy('closeNote')}
        <Input value={note} maxLength={1000} autoFocus onChange={(e) => setNote(e.target.value)} />
      </label>
      <Button type="button" size="sm" loading={close.isPending && close.variables === 'done'} disabled={close.isPending} onClick={() => run('done')}>
        {copy('closeDone')}
      </Button>
      <Button type="button" size="sm" variant="outline" loading={close.isPending && close.variables === 'canceled'} disabled={close.isPending} onClick={() => run('canceled')}>
        {copy('closeCancel')}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={close.isPending} onClick={() => setOpen(false)}>
        {copy('back')}
      </Button>
      {close.error ? <div className="basis-full"><ErrorCallout error={close.error} /></div> : null}
    </form>
  );
}

/** The newest prospects of an opened task (read then), and the pool filtered to it. */
function Newest({ item }: { item: ListedTask }) {
  const copy = useTaskCopy();
  const key = useLeadsKey();
  const id = item.task.id;
  const detail = useQuery({ queryKey: [...key, 'research', 'one', id], queryFn: () => getTask(id), enabled: item.found > 0 });
  if (item.found === 0) return <p className="text-sm text-muted-foreground">{copy('noProspects')}</p>;
  const rows = detail.data?.prospects.slice(0, NEWEST) ?? [];
  return (
    <Group title={copy('newest')}>
      {detail.error ? <ErrorCallout error={detail.error} /> : null}
      {rows.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-md border border-border bg-surface" aria-label={copy('newest')}>
          {rows.map((p) => (
            <li key={p.id} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
              <Link className="min-w-0 flex-1 truncate font-medium hover:underline" to={`/prospects/${encodeURIComponent(p.id)}`}>
                {p.business_name}
              </Link>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{formatRelative(p.created_at, copy.language)}</span>
              <ProspectStatusBadge status={p.status} />
            </li>
          ))}
        </ul>
      )}
      <Link className="mt-2 inline-flex min-h-8 items-center text-sm font-medium text-primary underline underline-offset-4" to={`/prospects?task=${encodeURIComponent(id)}`}>
        {copy('poolLink', { n: formatNumber(item.found, copy.language) })}
      </Link>
    </Group>
  );
}

/** What a task found, on the row's end: the count (of its target, for a one-off task) and the qualified. */
function Numbers({ item, copy }: { item: ListedTask; copy: TaskCopy }) {
  const { kind } = item.task;
  const n = (v: number) => formatNumber(v, copy.language);
  return (
    <span className="flex w-24 shrink-0 flex-col items-end gap-1 text-end sm:w-28">
      <span className="text-sm">
        <b className="font-semibold tabular-nums">{kind.type === 'ad_hoc' ? `${n(item.found)}/${n(kind.target_count)}` : n(item.found)}</b> {copy('foundWord')}
      </span>
      {kind.type === 'ad_hoc' && (
        <span aria-hidden="true" className="w-full">
          <Progress value={targetShare(item.found, kind.target_count)} className="h-1.5" tone={item.task.status === 'open' ? 'primary' : 'success'} />
        </span>
      )}
      <span className="text-xs text-muted-foreground">{copy('qualified', { n: n(item.qualified) })}</span>
    </span>
  );
}

/**
 * One research task as one row: its name, its brief in a line, where it stands (who is on it, or
 * that it waits), today's progress and its last find; what it found on the row's end. Opening it
 * shows the whole brief, the newest prospects, the claim and (a one-off task) closing.
 */
export function TaskRow({
  item,
  expanded,
  onToggle,
  segments,
  userId,
  quietWaiting,
}: {
  item: ListedTask;
  expanded: boolean;
  onToggle: () => void;
  segments: ReadonlyMap<string, string>;
  userId: string | undefined;
  /** The page says once what waiting tasks can expect: a row waiting for an agent says nothing more. */
  quietWaiting?: boolean;
}) {
  const copy = useTaskCopy();
  const { t } = useTranslation();
  const names = useLeadsNames();
  const { task } = item;
  const name = taskName(copy, task, segments);
  const named = task.kind.type === 'standing' && !!task.brief.segment_key && segments.has(task.brief.segment_key);
  const state = taskState(item, userId);
  const who = (s: Extract<TaskState, { kind: 'held' }>) => (s.who.kind === 'agent' ? names.agent(s.who.connection_id) : recorderText(t, names, s.who));
  const panel = `research-${task.id}-detail`;
  const open = task.status === 'open';
  const meta = [
    open ? copy('today', { n: item.found_today, cap: task.daily_cap }) : '',
    item.last_found_at ? copy('lastFound', { when: formatRelative(item.last_found_at, copy.language) }) : copy('noneYet'),
  ].filter(Boolean);
  return (
    <article
      id={`research-${task.id}`}
      aria-label={name}
      data-testid="research-task"
      className={cn('min-w-0 rounded-lg border bg-surface shadow-xs', 'border-border', !open && 'bg-surface/60')}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panel}
        onClick={onToggle}
        className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-3 text-start hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={cn('block truncate font-medium', !open && 'text-muted-foreground')}>{name}</span>
          <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{briefLine(copy, task, named)}</span>
          <StateLine state={state} who={who} quietWaiting={quietWaiting} />
          <span className="block truncate text-xs text-muted-foreground">{meta.join(' · ')}</span>
        </span>
        <Numbers item={item} copy={copy} />
        <ChevronDown aria-hidden="true" className={cn('mt-0.5 hidden h-5 w-5 shrink-0 text-muted-foreground transition-transform sm:block', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div id={panel} className="space-y-5 border-t border-border bg-surface-muted/40 px-3 py-4 sm:px-4">
          <BriefView item={item} segments={segments} named={named} />
          {task.kind.type === 'standing' && (
            <p className="text-sm text-muted-foreground">
              {copy('standing')}{' '}
              <Link className="font-medium text-primary underline underline-offset-4" to="/strategy">{copy('editStrategy')}</Link>
            </p>
          )}
          <Newest item={item} />
          {open && (
            <div className="flex flex-wrap items-start gap-x-4 gap-y-3 border-t border-border pt-4">
              <div className="min-w-0 flex-[1_1_18rem]"><Claim item={item} state={state} who={who} /></div>
              {task.kind.type === 'ad_hoc' && <Close item={item} />}
            </div>
          )}
          {!open && task.close_note && (
            <p className="text-sm text-muted-foreground">
              {task.close_note === AUTO_CLOSE_NOTE ? copy('autoClosed') : copy('closeNoteShown', { note: task.close_note })}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
