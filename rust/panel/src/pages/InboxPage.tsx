import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, PanelRight, Search } from 'lucide-react';
import * as api from '@/api/inbox';
import type { InboxConversationRow, InboxQueue } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { kindLabel } from '@/lib/capabilities';
import { personName } from '@/lib/people';
import { can } from '@/lib/roles';
import { QueryState } from '@/components/QueryState';
import { Badge, Button, Callout, cn, Disclosure, Input } from '@/components/ui';
import { InboxCompliance } from './InboxCompliance';
import { InboxErasure } from './InboxErasure';
import { InboxConversation } from './InboxConversation';
import { InboxJourneyPanel } from './InboxJourneyPanel';
import { Deadline, conversationClass, journeyClass, useInboxKey } from './InboxShared';

/** The surface badge of a row (spec §9): a direct message, a comment, a question, relayed mail. */
function surfaceKey(row: InboxConversationRow): 'private' | 'comment' | 'question' | 'relay' {
  if (row.surface === 'relay') return 'relay';
  if (row.surface === 'public') return row.channel?.endsWith('_question') ? 'question' : 'comment';
  return 'private';
}

/** A short timestamp like a mail list: the time today, the weekday this week, else the date. */
function shortTime(iso: string | null | undefined, language: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const locale = language.startsWith('tr') ? 'tr-TR' : 'en-GB';
  if (date.toDateString() === now.toDateString()) return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
  if (now.getTime() - date.getTime() < 6 * 86_400_000) return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date);
}

function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toLocaleUpperCase() || '·';
}

/** The customer spoke last and nobody answered yet: shown bold, like an unread mail. */
function awaitsReply(row: InboxConversationRow): boolean {
  if (row.state === 'closed' || !row.last_inbound_at) return false;
  return !row.last_outbound_at || row.last_inbound_at > row.last_outbound_at;
}

/** One conversation as a compact mail-list row: who, channel, state, when. */
function ConversationLink({ row }: { row: InboxConversationRow }) {
  const { t, i18n } = useTranslation();
  const key = useInboxKey();
  const person = useQuery({
    queryKey: [...key, 'person', row.person_id],
    queryFn: () => api.getPerson(row.person_id),
  });
  const { conversationId } = useParams();
  const name = personName(t, person.data?.person, person.data?.identities);
  const selected = conversationId === row.id;
  const unread = awaitsReply(row);
  const when = row.last_inbound_at && (!row.last_outbound_at || row.last_inbound_at > row.last_outbound_at) ? row.last_inbound_at : row.last_outbound_at ?? row.updated_at;
  return (
    <Link
      to={`/inbox/${encodeURIComponent(row.id)}`}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'grid min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 border-b border-border/60 px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        selected ? 'bg-primary-50 shadow-[inset_3px_0_0_var(--primary)] dark:bg-primary-950/50' : 'hover:bg-surface-muted',
      )}
    >
      <span className="row-span-2 flex h-8 w-8 items-center justify-center rounded-full bg-surface-muted text-xs font-semibold text-foreground" aria-hidden="true">{initials(name)}</span>
      <span className={cn('truncate', unread ? 'font-semibold text-foreground' : 'font-medium')}>{name}</span>
      <time dateTime={when} className={cn('text-[11px] tabular-nums', unread ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{shortTime(when, i18n.language)}</time>
      <span className="col-span-2 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
        <span className="shrink-0 rounded-full bg-surface-muted px-1.5 py-px text-[11px] text-foreground/80">{kindLabel(t, row.kind_key)}</span>
        <span className="truncate">{t(`inbox.state.${typeof row.state === 'string' ? row.state : 'snoozed'}`)}</span>
        {row.surface && <Badge size="sm" tone={row.surface === 'private' ? 'neutral' : 'primary'}>{t(`inbox.public.surface.${surfaceKey(row)}`)}</Badge>}
        {!!row.owed_items && <Badge size="sm" tone="warning">{t('inbox.public.owed', { count: row.owed_items })}</Badge>}
        {!!row.held_replies && <Badge size="sm" tone="info">{t('inbox.public.heldCount', { count: row.held_replies })}</Badge>}
        {row.next_deadline && <Deadline at={row.next_deadline} />}
      </span>
    </Link>
  );
}

const JOURNEY_PANE_KEY = 'jeeta.inbox.journeyPane';
function readJourneyPane(): boolean {
  try { return window.localStorage.getItem(JOURNEY_PANE_KEY) !== 'closed'; } catch { return true; }
}

export function InboxPage() {
  const { t } = useTranslation();
  const session = useSession();
  const allowed = can(session.data, 'inbox.work');
  const manage = can(session.data, 'inbox.manage');
  const key = useInboxKey();
  const { conversationId } = useParams();
  const [params] = useSearchParams();
  const [queue, setQueue] = useState<InboxQueue | 'approvals'>('ours');
  const [search, setSearch] = useState('');
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [journeyPane, setJourneyPane] = useState(readJourneyPane);
  const toggleJourneyPane = () => setJourneyPane((open) => {
    try { window.localStorage.setItem(JOURNEY_PANE_KEY, open ? 'closed' : 'open'); } catch { /* per-viewer convenience only */ }
    return !open;
  });
  useEffect(() => setQueueExpanded(false), [conversationId, params.get('person'), params.get('task')]);
  const rows = useInfiniteQuery({
    queryKey: [...key, 'conversations', queue],
    queryFn: ({ pageParam }) => api.listConversations(queue as InboxQueue, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: allowed && queue !== 'approvals',
  });
  // The held replies waiting for a human (spec §3.7), from inbox.pending.
  const pending = useQuery({
    queryKey: [...key, 'pending'],
    queryFn: api.getInboxPending,
    enabled: allowed && queue === 'approvals',
  });
  const people = useQuery({
    queryKey: [...key, 'search', search.trim()],
    queryFn: () => api.searchPeople(search.trim()),
    enabled: allowed && !!search.trim(),
  });
  const personId = params.get('person');
  const selectedPerson = useQuery({
    queryKey: [...key, 'person', personId],
    queryFn: () => api.getPerson(personId!),
    enabled: allowed && !!personId,
  });
  const taskId = params.get('task');
  const tasks = useQuery({
    queryKey: [...key, 'tasks'],
    queryFn: () => api.listTasks(),
    enabled: allowed && !!taskId,
  });
  const task = tasks.data?.find((row) => row.id === taskId);
  const journeyId = task?.journey_id ?? selectedPerson.data?.open_journey?.id;
  const hasSelection = !!conversationId || !!personId || !!taskId;
  if (session.isPending) return <QueryState query={session} />;
  if (!allowed)
    return (
      <Callout tone="warning">
        {t('errors.missingPermission', { permission: t('permissions.inbox.work') })}
      </Callout>
    );
  const queues: (InboxQueue | 'approvals')[] = ['ours', 'unassigned', 'snoozed', 'all', 'approvals'];
  const queueLabel = (value: InboxQueue | 'approvals') => value === 'approvals' ? t('inbox.public.approvals') : t(`inbox.queue.${value}`);
  const listHidden = hasSelection && !queueExpanded;
  return (
    <div className="flex min-w-0 flex-col lg:h-[calc(100dvh-61px)] lg:min-h-[36rem]">
      <header className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="font-display text-xl font-medium">{t('inbox.title')}</h1>
        <label className="relative min-w-[12rem] max-w-md flex-1">
          <span className="sr-only">{t('inbox.search')}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input className="h-9 bg-surface pl-9" type="search" placeholder={t('inbox.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <div className="ms-auto flex items-center gap-1">
          {manage && <Button asChild size="sm" variant="ghost"><Link to="/inbox/merges">{t('inbox.merges.title')}</Link></Button>}
          <Button size="sm" variant="ghost" className="hidden xl:inline-flex" aria-pressed={journeyPane} onClick={toggleJourneyPane}>
            <PanelRight className="h-4 w-4" aria-hidden="true" />{t('inbox.journey')}
          </Button>
        </div>
      </header>
      <div
        data-testid="inbox-columns"
        className={cn(
          'grid min-w-0 grid-cols-1 overflow-hidden bg-surface',
          'lg:min-h-0 lg:flex-1 lg:grid-cols-[11rem_19rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]',
          journeyPane ? 'xl:grid-cols-[11rem_21rem_minmax(0,1fr)_17rem] xl:grid-rows-1' : 'xl:grid-cols-[11rem_21rem_minmax(0,1fr)] xl:grid-rows-1 xl:[&_.inbox-journey]:hidden',
        )}
      >
        {hasSelection && <Button variant="ghost" className="justify-between rounded-none border-b border-border px-4 lg:hidden" aria-expanded={queueExpanded} aria-controls="inbox-queue-content" onClick={() => setQueueExpanded((value) => !value)}>
          {t('inbox.ux.browseQueues', { defaultValue: 'Kuyruklar ve kişi araması' })}
          <ChevronDown className={`h-4 w-4 ${queueExpanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </Button>}
        <nav aria-label={t('inbox.queues')} className={cn('min-w-0 border-b border-border bg-surface-muted/60 p-2 lg:row-span-2 xl:row-span-1 lg:flex lg:flex-col lg:gap-0.5 lg:overflow-y-auto lg:border-b-0 lg:border-e', listHidden ? 'hidden' : 'flex gap-1 overflow-x-auto')}>
          <h2 className="hidden px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground lg:block">{t('inbox.queues')}</h2>
          {queues.map((value) => (
            <Button
              key={value}
              size="sm"
              variant="ghost"
              className={cn('shrink-0 justify-start rounded-md px-2.5 lg:w-full', value === 'approvals' && 'lg:mt-3', queue === value ? 'bg-primary-50 font-semibold text-foreground dark:bg-primary-950/60' : 'text-muted-foreground')}
              aria-pressed={queue === value}
              onClick={() => setQueue(value)}
            >
              {queueLabel(value)}
            </Button>
          ))}
        </nav>
        <section id="inbox-queue-content" aria-label={search.trim() ? t('inbox.search') : queueLabel(queue)} className={cn('min-w-0 flex-col border-b border-border lg:row-span-2 xl:row-span-1 lg:flex lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-e', listHidden ? 'hidden' : 'flex max-h-[28rem] overflow-y-auto')}>
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-surface/95 px-3 py-2 text-xs text-muted-foreground backdrop-blur">
            <span className="font-medium text-foreground">{search.trim() ? t('inbox.search') : queueLabel(queue)}</span>
          </div>
          {queue === 'approvals' && !search.trim() ? (
            <QueryState query={pending}>
              {pending.data?.approvals?.map((held) => (
                <Link
                  key={held.outbox_id}
                  data-testid="approval"
                  className="flex flex-col gap-1 border-b border-border/60 px-3 py-2.5 text-sm shadow-[inset_3px_0_0_var(--warning)] hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  to={`/inbox/${encodeURIComponent(held.conversation_id)}`}
                >
                  <span className="font-medium">{t('inbox.public.approvalFor')}</span>
                  {held.deadline && <Deadline at={held.deadline} />}
                </Link>
              ))}
              {pending.data && !pending.data.approvals?.length && (
                <p className="px-3 py-4 text-sm text-muted-foreground">{t('inbox.public.noApprovals')}</p>
              )}
            </QueryState>
          ) : search.trim() ? (
            <QueryState query={people}>
              {people.data?.map((person) => (
                <Link
                  key={person.id}
                  className="border-b border-border/60 px-3 py-2.5 text-sm hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  to={`/inbox?person=${encodeURIComponent(person.id)}`}
                >
                  <span className="font-medium">{personName(t, person)}</span>
                  {person.company && <span className="block text-xs text-muted-foreground">{person.company}</span>}
                </Link>
              ))}
              {people.data?.length === 0 && (
                <div className="space-y-3 p-3">
                  <p className="text-sm text-muted-foreground">{t('people.noMatch')}</p>
                  <Button size="sm" variant="outline" onClick={() => setSearch('')}>{t('people.clearSearch')}</Button>
                </div>
              )}
            </QueryState>
          ) : (
            <QueryState query={rows}>
              {rows.data?.pages
                .flatMap((page) => page.items)
                .map((row) => (
                  <ConversationLink key={row.id} row={row} />
                ))}
              {rows.data?.pages[0]?.items.length === 0 && (
                <div className="space-y-2 px-3 py-4 text-sm text-muted-foreground">
                  <p>{t('inbox.empty')}</p>
                  <p className="leading-6">{t('inbox.ux.emptyQueueHint', { defaultValue: 'Başka bir kuyruk seçin veya bir kişiyi arayın. Yeni görüşmeler bağlı müşteri kanallarından buraya gelir.' })}</p>
                </div>
              )}
              {rows.hasNextPage && (
                <Button
                  variant="ghost"
                  className="m-2"
                  loading={rows.isFetchingNextPage}
                  onClick={() => void rows.fetchNextPage()}
                >
                  {t('inbox.more')}
                </Button>
              )}
            </QueryState>
          )}
        </section>
        {conversationId ? (
          <InboxConversation
            key={`${session.data?.current_workspace}:${conversationId}`}
            id={conversationId}
          />
        ) : (
          <>
            <section className={cn(conversationClass, !hasSelection && 'hidden lg:flex')} aria-label={t('inbox.thread')}>
              <h2 className="font-display text-lg font-medium">
                {selectedPerson.data
                  ? personName(t, selectedPerson.data.person, selectedPerson.data.identities)
                  : t('inbox.thread')}
              </h2>
              {!selectedPerson.data ? (
                <div className="flex min-h-72 flex-1 flex-col items-center justify-center text-center">
                  <p className="max-w-sm text-sm leading-6 text-muted-foreground">{t('inbox.ux.chooseHint', { defaultValue: 'Kuyruktan bir görüşme seçin. Kişi aramasıyla geçmiş görüşmelere de ulaşabilirsiniz.' })}</p>
                </div>
              ) : <p className="text-sm text-muted-foreground">{t('inbox.choose')}</p>}
              {selectedPerson.data && !selectedPerson.data.person.erased_at && !selectedPerson.data.person.merged_into && <>
                <Disclosure key={selectedPerson.data.person.id} title={t('inbox.compliance.title')}><InboxCompliance personId={selectedPerson.data.person.id} /></Disclosure>
              </>}
              {personId && (
                <QueryState query={selectedPerson}>
                  {selectedPerson.data?.conversations.map((row) => (
                    <ConversationLink key={row.id} row={row} />
                  ))}
                  {selectedPerson.data?.conversations.length === 0 && <p>{t('inbox.noConversations')}</p>}
                </QueryState>
              )}
              {selectedPerson.data && !selectedPerson.data.person.erased_at && !selectedPerson.data.person.merged_into &&
                <InboxErasure key={`erase:${selectedPerson.data.person.id}`} personId={selectedPerson.data.person.id} />}
              {taskId && (
                <QueryState query={tasks}>
                  {tasks.data && !task && <p>{t('inbox.taskNotFound')}</p>}
                </QueryState>
              )}
            </section>
            {journeyId ? (
              <InboxJourneyPanel
                key={journeyId}
                journeyId={journeyId}
                personId={selectedPerson.data?.person.id}
              />
            ) : (
              <section className={cn(journeyClass, !hasSelection && 'hidden xl:flex')}>
                <h2 className="text-sm font-medium">{t('inbox.journey')}</h2>
                <p className="text-sm leading-6 text-muted-foreground">{t('inbox.noJourney')}</p>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
