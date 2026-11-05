import { WorkspaceHeader } from '@/components/WorkspaceHeader';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { claimTask, closeTask, createTask, getTask, listTasks } from '@/api/research';
import { TASK_STATUSES, type Brief, type TaskOut, type TaskStatus } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Disclosure,
  EmptyState,
  Input,
  Progress,
  Textarea,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { areaLines, lines, useDraftKey, useInFlight } from '@/lib/leads';
import { selectClass } from './InboxShared';
import { ProspectStatusBadge, recorderText, useLeadsKey, useLeadsNames, useLeadsRefresh } from './LeadsShared';
import { taskLabel } from './ProspectsPage';

/** A brief as a few lines: sectors, areas, signals, exclusions, size, language, note. */
function BriefView({ brief }: { brief: Brief }) {
  const { t } = useTranslation();
  const rows: [string, string][] = [
    [t('leads.tasks.brief.segment'), brief.segment_key ?? ''],
    [t('leads.tasks.brief.sectors'), brief.sectors.join(', ')],
    [t('leads.tasks.brief.areas'), brief.areas.map((a) => (a.district ? `${a.city} / ${a.district}` : a.city)).join(', ')],
    [t('leads.tasks.brief.signals'), brief.signals.join(', ')],
    [t('leads.tasks.brief.exclusions'), brief.exclusions.join(', ')],
    [t('leads.tasks.brief.size'), brief.size_hint],
    [t('leads.tasks.brief.language'), brief.language ?? ''],
    [t('leads.tasks.brief.note'), brief.note],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-3">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** How many a task found so far (and of its target), and its newest prospects; read when opened. */
function TaskProgress({ id }: { id: string }) {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const detail = useQuery({ queryKey: [...key, 'research', 'one', id], queryFn: () => getTask(id) });
  const d = detail.data;
  const target = d?.task.kind.type === 'ad_hoc' ? d.task.kind.target_count : null;
  return (
    <QueryState query={detail}>
      {d && (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            {target != null ? t('leads.tasks.foundOf', { found: d.found, target }) : t('leads.tasks.found', { found: d.found })}
          </p>
          {target != null && <Progress value={Math.min(100, Math.round((d.found / Math.max(1, target)) * 100))} />}
          {d.prospects.length > 0 && (
            <ul className="flex flex-col gap-1" aria-label={t('leads.tasks.newest')}>
              {d.prospects.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2">
                  <Link className="text-primary hover:underline" to={`/prospects/${encodeURIComponent(p.id)}`}>
                    {p.business_name}
                  </Link>
                  <ProspectStatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          )}
          <Link className="text-primary hover:underline" to={`/prospects?task=${encodeURIComponent(id)}`}>
            {t('leads.tasks.prospectsLink')}
          </Link>
        </div>
      )}
    </QueryState>
  );
}

/** One task: its brief, today's remaining, the claim, closing; every action pending on its own. */
function TaskCard({ item }: { item: TaskOut }) {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const names = useLeadsNames();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const task = item.task;
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState<'done' | 'canceled'>('done');
  const [note, setNote] = useState('');
  const claim = useMutation({
    mutationFn: () => claimTask(task.id),
    onSuccess: async (out) => {
      if (out.held_by_other) toast.info(t('leads.tasks.heldByOther'));
      else toast.success(t('leads.tasks.claimed'));
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const close = useMutation({
    mutationFn: () => closeTask(task.id, { outcome, note: note.trim() || undefined }),
    onSuccess: async () => {
      setClosing(false);
      toast.success(t('leads.tasks.closed'));
      await refresh();
    },
  });
  const live = task.claim && new Date(task.claim.until).getTime() > Date.now() ? task.claim : null;
  const mine =
    live &&
    ((live.by.kind === 'human' && live.by.user_id === session.data?.user_id) ||
      (live.by.kind === 'agent' && live.by.user_id === session.data?.user_id));
  const submitClose = (e: FormEvent) => {
    e.preventDefault();
    guard((release) => close.mutate(undefined, { onSettled: release }));
  };
  return (
    <article data-testid="research-task" className="border-b border-border py-5">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium">{taskLabel(t, task)}</h2>
        <Badge tone={task.status === 'open' ? 'success' : 'neutral'}>{t(`leads.tasks.statuses.${task.status}`)}</Badge>
        {task.kind.type === 'ad_hoc' && <Badge tone="info">{t('leads.tasks.target', { n: task.kind.target_count })}</Badge>}
      </header>
      <div className="flex flex-col gap-3">
        <BriefView brief={task.brief} />
        <p className="text-sm">
          {t('leads.tasks.remaining', { remaining: item.remaining_today, cap: task.daily_cap })}
        </p>
        {live && (
          <p className="text-caption text-muted-foreground">
            {mine
              ? t('leads.tasks.claimedByYou', { until: formatDateTime(live.until, i18n.language) })
              : t('leads.tasks.claimedBy', {
                  name: recorderText(t, names, live.by),
                  until: formatDateTime(live.until, i18n.language),
                })}
          </p>
        )}
        {task.status === 'open' && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" loading={claim.isPending} onClick={() => !claim.isPending && claim.mutate()}>
              {t('leads.tasks.claim')}
            </Button>
            {task.kind.type === 'ad_hoc' && !closing && (
              <Button size="sm" variant="ghost" onClick={() => setClosing(true)}>
                {t('leads.tasks.close')}
              </Button>
            )}
          </div>
        )}
        {closing && (
          <form className="flex flex-col gap-2 rounded-lg border border-border p-3" onSubmit={submitClose} aria-label={t('leads.tasks.close')}>
            <fieldset className="flex flex-wrap gap-3 text-sm">
              <legend className="mb-1 font-medium">{t('leads.tasks.outcome')}</legend>
              {(['done', 'canceled'] as const).map((o) => (
                <label key={o} className="flex items-center gap-1">
                  <input type="radio" name={`outcome-${task.id}`} checked={outcome === o} onChange={() => setOutcome(o)} />
                  {t(`leads.tasks.outcomes.${o}`)}
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.tasks.closeNote')}
              <Textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
            </label>
            <ErrorCallout error={close.error} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" loading={close.isPending}>
                {t('leads.tasks.closeSubmit')}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={close.isPending} onClick={() => setClosing(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        )}
        <Disclosure title={t('leads.tasks.progress')}>
          <TaskProgress id={task.id} />
        </Disclosure>
      </div>
    </article>
  );
}

const EMPTY_FORM = {
  segment: '',
  sectors: '',
  areas: '',
  signals: '',
  exclusions: '',
  size: '',
  language: '',
  note: '',
  target: '20',
  dailyCap: '10',
};

/** An ad-hoc task; the form mirrors the brief. One request key per draft; Enter cannot submit twice. */
function CreateTask() {
  const { t } = useTranslation();
  const refresh = useLeadsRefresh();
  const draftKey = useDraftKey();
  const guard = useInFlight();
  const [form, setForm] = useState(EMPTY_FORM);
  const set = (name: keyof typeof EMPTY_FORM) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [name]: e.target.value }));
  const brief: Brief = {
    segment_key: form.segment.trim() || null,
    sectors: lines(form.sectors),
    areas: areaLines(form.areas),
    signals: lines(form.signals),
    exclusions: lines(form.exclusions),
    size_hint: form.size.trim(),
    language: form.language.trim() || null,
    note: form.note.trim(),
  };
  const target = Number(form.target);
  const dailyCap = Number(form.dailyCap);
  const valid =
    brief.sectors.length > 0 &&
    brief.areas.length > 0 &&
    brief.areas.every((a) => a.city) &&
    Number.isInteger(target) &&
    target >= 1 &&
    target <= 500 &&
    Number.isInteger(dailyCap) &&
    dailyCap >= 1 &&
    dailyCap <= 500;
  const create = useMutation({
    mutationFn: () => {
      const input = { brief, target_count: target, daily_cap: dailyCap };
      return createTask({ ...input, request_key: draftKey.keyFor(input) });
    },
    onSuccess: async () => {
      toast.success(t('leads.tasks.create.created'));
      setForm(EMPTY_FORM);
      draftKey.reset();
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    guard((release) => create.mutate(undefined, { onSettled: release }));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('leads.tasks.create.title')}</CardTitle>
        <CardDescription>{t('leads.tasks.create.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit} aria-label={t('leads.tasks.create.title')}>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.tasks.create.sectors')}
            <Textarea value={form.sectors} onChange={set('sectors')} placeholder={t('leads.tasks.create.sectorsHint')} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.tasks.create.areas')}
            <Textarea value={form.areas} onChange={set('areas')} placeholder={t('leads.tasks.create.areasHint')} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.tasks.create.signals')}
            <Textarea value={form.signals} onChange={set('signals')} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.tasks.create.exclusions')}
            <Textarea value={form.exclusions} onChange={set('exclusions')} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.tasks.create.segment')}
            <Input value={form.segment} autoComplete="off" onChange={set('segment')} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.tasks.create.size')}
            <Input value={form.size} autoComplete="off" maxLength={200} onChange={set('size')} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.tasks.create.language')}
            <Input value={form.language} autoComplete="off" onChange={set('language')} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.tasks.create.target')}
            <Input type="number" min={1} max={500} value={form.target} onChange={set('target')} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.tasks.create.dailyCap')}
            <Input type="number" min={1} max={500} value={form.dailyCap} onChange={set('dailyCap')} />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            {t('leads.tasks.create.note')}
            <Textarea value={form.note} maxLength={1000} onChange={set('note')} />
          </label>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <ErrorCallout error={create.error} />
            <div>
              <Button type="submit" disabled={!valid} loading={create.isPending}>
                {t('leads.tasks.create.submit')}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** `/prospects/tasks`: standing and ad-hoc research tasks, their progress, claims and a new one (spec §9). */
export function ResearchTasksPage() {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const [status, setStatus] = useState<TaskStatus | ''>('open');
  const [creating, setCreating] = useState(false);
  const tasks = useQuery({
    queryKey: [...key, 'research', 'list', status || 'all'],
    queryFn: () => listTasks({ status: status || undefined }),
  });
  const items = tasks.data?.items ?? [];
  return (
    <>
      <WorkspaceHeader scene="research"
        title={t('leads.tasks.title')}
        description={t('leads.tasks.description')}
        actions={
          <Button asChild variant="outline">
            <Link to="/prospects">{t('leads.tasks.poolLink')}</Link>
          </Button>
        }
      />
      <label className="flex max-w-xs flex-col gap-1 text-sm">
        {t('leads.tasks.statusFilter')}
        <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | '')}>
          <option value="">{t('leads.prospects.filters.all')}</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`leads.tasks.statuses.${s}`)}
            </option>
          ))}
        </select>
      </label>
      <QueryState query={tasks}>
        {items.length === 0 ? (
          status ? <EmptyState title={t('leads.filteredEmpty.title')} description={t('leads.filteredEmpty.body')}
            action={<Button variant="outline" onClick={() => setStatus('')}>{t('leads.filteredEmpty.clear')}</Button>} /> :
          <EmptyState title={t('leads.tasks.empty')} description={t('leads.tasks.emptyBody')} />
        ) : (
          <div className="border-t border-border">
            {items.map((item) => (
              <TaskCard key={item.task.id} item={item} />
            ))}
          </div>
        )}
      </QueryState>
      <div className="border-t border-border pt-4">
        <Button type="button" variant="outline" aria-expanded={creating} aria-controls="research-create"
          onClick={() => setCreating((open) => !open)}>
          {creating ? t('leads.ux.hideTaskForm', { defaultValue: 'Hide task form' }) : t('leads.tasks.create.title')}
        </Button>
        <div id="research-create" hidden={!creating} className="mt-4"><CreateTask /></div>
      </div>
    </>
  );
}
