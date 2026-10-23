import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/inbox';
import { listTeam } from '@/api/team';
import type { InboxEvent, ReportEvent } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { can, isOwnerOrManager } from '@/lib/roles';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Badge, Button, Input, Textarea } from '@/components/ui';
import { InboxMergeBanner } from './InboxMerges';
import {
  columnClass,
  InboxActorLabel,
  InboxTime,
  selectClass,
  useInboxKey,
  useInboxMutation,
} from './InboxShared';

function eventName(kind: InboxEvent['kind']) {
  if (typeof kind === 'string') return kind;
  if ('call_made' in kind) return 'call_made';
  if ('won' in kind) return 'won';
  if ('lost' in kind) return 'lost';
  if ('snoozed' in kind) return 'snoozed';
  return 'merged';
}

function EventDetails({ event }: { event: InboxEvent }) {
  const { t } = useTranslation();
  const kind = event.kind;
  if (typeof kind === 'string') return null;
  if ('lost' in kind) return <p>{event.reason_label ?? kind.lost.reason_key}</p>;
  if ('call_made' in kind)
    return <p>{t(kind.call_made.connected ? 'inbox.connected' : 'inbox.notConnected')}</p>;
  if ('won' in kind)
    return (
      <p>
        {kind.won.product} · {kind.won.amount_minor / 100} {kind.won.currency}
      </p>
    );
  if ('snoozed' in kind) return <InboxTime at={kind.snoozed.until} />;
  if ('merged' in kind) return <p>{kind.merged.target}</p>;
  return null;
}

function EventForm({ journeyId }: { journeyId: string }) {
  const { t } = useTranslation();
  const key = useInboxKey();
  const [kind, setKind] = useState<Exclude<ReportEvent['kind'], 'reopened'>>('call_made');
  const [connected, setConnected] = useState(false);
  const [product, setProduct] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('TRY');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const reasons = useQuery({ queryKey: [...key, 'lost-reasons'], queryFn: api.listLostReasons });
  const attempt = useRef<{ body: string; key: string }>();
  const save = useInboxMutation(
    (event: ReportEvent) => {
      const body = JSON.stringify(event);
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      return api.reportEvent(journeyId, { ...event, idempotency_key: attempt.current.key });
    },
    () => {
      attempt.current = undefined;
    },
  );
  const valid =
    kind === 'won'
      ? !!product.trim() &&
        amount !== '' &&
        Number.isSafeInteger(Number(amount)) &&
        Number(amount) >= 0 &&
        /^[A-Z]{3}$/.test(currency)
      : kind === 'lost'
        ? !!reasons.data?.some((row) => row.key === reason && row.active)
        : kind === 'snoozed'
          ? !!until && new Date(until).getTime() > Date.now()
          : true;
  const submit = () => {
    if (!valid) return;
    switch (kind) {
      case 'call_made':
        save.mutate({ kind, payload: { connected } });
        break;
      case 'won':
        save.mutate({ kind, payload: { product: product.trim(), amount_minor: Number(amount), currency } });
        break;
      case 'lost':
        save.mutate({ kind, payload: { reason_key: reason } });
        break;
      case 'snoozed':
        save.mutate({ kind, payload: { until: new Date(until).toISOString() } });
        break;
      default:
        save.mutate({ kind, payload: {} });
    }
  };
  return (
    <form
      aria-label={t('inbox.report')}
      className="flex flex-col gap-3 border-t pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3 className="font-medium">{t('inbox.report')}</h3>
      <label className="text-sm">
        {t('inbox.event')}
        <select
          className={selectClass}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            save.reset();
          }}
        >
          {(
            [
              'call_made',
              'appointment_booked',
              'meeting_held',
              'quote_accepted',
              'won',
              'lost',
              'snoozed',
            ] as const
          ).map((value) => (
            <option value={value} key={value}>
              {t(`inbox.eventKind.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {kind === 'call_made' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={connected} onChange={(e) => setConnected(e.target.checked)} />
          {t('inbox.connected')}
        </label>
      )}
      {kind === 'won' && (
        <>
          <label className="text-sm">
            {t('inbox.product')}
            <Input required value={product} onChange={(e) => setProduct(e.target.value)} />
          </label>
          <label className="text-sm">
            {t('inbox.amount')}
            <Input
              required
              type="number"
              min="0"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="text-sm">
            {t('inbox.currency')}
            <Input
              required
              pattern="[A-Z]{3}"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </label>
        </>
      )}
      {kind === 'lost' && (
        <QueryState query={reasons}>
          <label className="text-sm">
            {t('inbox.lostReason')}
            <select
              required
              className={selectClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              <option value="">{t('inbox.chooseReason')}</option>
              {reasons.data
                ?.filter((row) => row.active)
                .map((row) => (
                  <option key={row.key} value={row.key}>
                    {row.label}
                  </option>
                ))}
            </select>
          </label>
        </QueryState>
      )}
      {kind === 'snoozed' && (
        <label className="text-sm">
          {t('inbox.snoozeUntil')}
          <Input required type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
      )}
      <ErrorCallout error={save.error} />
      {save.isSuccess && (
        <p role="status" className="text-sm text-success">
          {t('inbox.saved')}
        </p>
      )}
      <Button type="submit" disabled={!valid} loading={save.isPending}>
        {t('inbox.report')}
      </Button>
    </form>
  );
}

export function InboxJourneyPanel({
  journeyId,
  personId,
  reopenInbound = false,
}: {
  journeyId: string;
  personId?: string;
  reopenInbound?: boolean;
}) {
  const { t } = useTranslation();
  const key = useInboxKey();
  const session = useSession();
  const manage = can(session.data, 'inbox.manage');
  const data = useQuery({
    queryKey: [...key, 'journey', journeyId],
    queryFn: () => api.getJourney(journeyId),
  });
  const team = useQuery({
    queryKey: [...key, 'team'],
    queryFn: listTeam,
    enabled: can(session.data, 'workspace.read'),
  });
  const members = team.data?.filter((member) => member.status === 'active' && member.user_id) ?? [];
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [assignee, setAssignee] = useState('');
  const [note, setNote] = useState('');
  const assign = useInboxMutation((id: string | null) => api.assignOwner(journeyId, id));
  const create = useInboxMutation(
    () =>
      api.createTask(journeyId, {
        title: title.trim(),
        due_at: new Date(due).toISOString(),
        assignee: assignee || null,
      }),
    () => {
      setTitle('');
      setDue('');
    },
  );
  const complete = useInboxMutation(api.completeTask);
  const add = useInboxMutation(
    () => api.addNote(journeyId, note.trim()),
    () => setNote(''),
  );
  const reopen = useInboxMutation(() =>
    api.reportEvent(journeyId, { kind: 'reopened', idempotency_key: crypto.randomUUID(), payload: {} }),
  );
  const journey = data.data?.journey;
  return (
    <aside className={columnClass} aria-label={t('inbox.journey')}>
      <h2 className="font-semibold">{t('inbox.journey')}</h2>
      <QueryState query={data}>
        {journey && (
          <>
            <div>
              <Badge
                tone={journey.status === 'lost' ? 'danger' : journey.status === 'won' ? 'success' : 'primary'}
              >
                {t(`inbox.status.${journey.status}`)}
              </Badge>
              {journey.lost_reason && <p className="mt-2 text-sm">{journey.lost_reason.reason_label}</p>}
            </div>
            {journey.status === 'lost' && reopenInbound && manage && isOwnerOrManager(session.data) && (
              <Button loading={reopen.isPending} onClick={() => reopen.mutate()}>
                {t('inbox.reopen')}
              </Button>
            )}
            <ErrorCallout error={reopen.error} />
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{t('inbox.owner')}</h3>
              {manage ? (
                <label className="text-sm">
                  <span className="sr-only">{t('inbox.owner')}</span>
                  <select
                    className={selectClass}
                    value={journey.owner ?? ''}
                    disabled={assign.isPending || team.isLoading || team.isError}
                    onChange={(e) => assign.mutate(e.target.value || null)}
                  >
                    <option value="">{t('inbox.unassigned')}</option>
                    {journey.owner && !members.some((member) => member.user_id === journey.owner) && (
                      <option value={journey.owner}>{journey.owner}</option>
                    )}
                    {members.map((member) => (
                      <option key={member.user_id} value={member.user_id!}>
                        {member.display_name || member.email}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="text-sm">
                  {members.find((member) => member.user_id === journey.owner)?.display_name ||
                    journey.owner ||
                    t('inbox.unassigned')}
                </p>
              )}
              <ErrorCallout error={assign.error} />
              <ErrorCallout error={team.error} />
            </div>
            <InboxMergeBanner personId={personId ?? journey.person_id} />
            <section>
              <h3 className="mb-3 font-medium">{t('inbox.timeline')}</h3>
              <ol className="flex flex-col gap-4 border-l border-border pl-3">
                {data.data?.events
                  .slice()
                  .sort((a, b) => a.at.localeCompare(b.at))
                  .map((event) => (
                    <li key={event.id} className="text-sm">
                      <InboxActorLabel actor={event.source} />
                      <p className="font-medium">{t(`inbox.eventKind.${eventName(event.kind)}`)}</p>
                      <EventDetails event={event} />
                      <InboxTime at={event.at} />
                    </li>
                  ))}
              </ol>
              {data.data?.events.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('inbox.noEvents')}</p>
              )}
            </section>
            {journey.status !== 'lost' && journey.status !== 'won' && <EventForm journeyId={journeyId} />}
            <section className="flex flex-col gap-3 border-t pt-4">
              <h3 className="font-medium">{t('inbox.tasks')}</h3>
              {data.data?.tasks.map((task) => (
                <div key={task.id} id={`task-${task.id}`} className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">{task.title}</p>
                  <InboxTime at={task.due_at} />
                  <p>
                    {t(`inbox.taskStatus.${task.status}`)} ·{' '}
                    {members.find((member) => member.user_id === task.assignee)?.display_name ||
                      task.assignee ||
                      t('inbox.unassigned')}
                  </p>
                  {task.status === 'open' && (
                    <Button
                      variant="outline"
                      size="sm"
                      loading={complete.isPending}
                      onClick={() => complete.mutate(task.id)}
                    >
                      {t('inbox.complete')}
                    </Button>
                  )}
                </div>
              ))}
              <ErrorCallout error={complete.error} />
              <form
                aria-label={t('inbox.addTask')}
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (title.trim() && due) create.mutate();
                }}
              >
                <label className="text-sm">
                  {t('inbox.taskTitle')}
                  <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="text-sm">
                  {t('inbox.due')}
                  <Input
                    required
                    type="datetime-local"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                  />
                </label>
                <label className="text-sm">
                  {t('inbox.assignee')}
                  <select
                    className={selectClass}
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                  >
                    <option value="">{t('inbox.unassigned')}</option>
                    {members.map((member) => (
                      <option key={member.user_id} value={member.user_id!}>
                        {member.display_name || member.email}
                      </option>
                    ))}
                  </select>
                </label>
                <ErrorCallout error={create.error} />
                <Button
                  variant="outline"
                  type="submit"
                  loading={create.isPending}
                  disabled={!title.trim() || !due}
                >
                  {t('inbox.addTask')}
                </Button>
              </form>
            </section>
            <section className="flex flex-col gap-3 border-t pt-4">
              <h3 className="font-medium">{t('inbox.notes')}</h3>
              {data.data?.notes.map((item) => (
                <div key={item.id} className="rounded-lg bg-surface-muted p-3">
                  <InboxActorLabel actor={item.author} />
                  <p className="whitespace-pre-wrap text-sm">{item.text}</p>
                  <InboxTime at={item.at} />
                </div>
              ))}
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (note.trim()) add.mutate();
                }}
              >
                <label className="text-sm">
                  {t('inbox.note')}
                  <Textarea required value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
                <ErrorCallout error={add.error} />
                <Button type="submit" variant="outline" loading={add.isPending} disabled={!note.trim()}>
                  {t('inbox.addNote')}
                </Button>
              </form>
            </section>
          </>
        )}
      </QueryState>
    </aside>
  );
}
