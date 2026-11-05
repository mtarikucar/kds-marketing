import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Search } from 'lucide-react';
import * as api from '@/api/inbox';
import type { InboxConversationRow, InboxQueue } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { kindLabel } from '@/lib/capabilities';
import { personName } from '@/lib/people';
import { can } from '@/lib/roles';
import { QueryState } from '@/components/QueryState';
import { Badge, Button, Callout, Disclosure, Input, PageHeader } from '@/components/ui';
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

function ConversationLink({ row }: { row: InboxConversationRow }) {
  const { t } = useTranslation();
  const key = useInboxKey();
  const person = useQuery({
    queryKey: [...key, 'person', row.person_id],
    queryFn: () => api.getPerson(row.person_id),
  });
  const { conversationId } = useParams();
  return (
    <Link
      to={`/inbox/${encodeURIComponent(row.id)}`}
      aria-current={conversationId === row.id ? 'page' : undefined}
      className={`block min-w-0 border-l-2 px-3 py-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${conversationId === row.id ? 'border-brand-accent bg-surface' : 'border-transparent hover:bg-surface'}`}
    >
      <span className="block truncate font-medium">{personName(t, person.data?.person, person.data?.identities)}</span>
      <span className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
        <span>{kindLabel(t, row.kind_key)}</span>
        <span>{t(`inbox.state.${typeof row.state === 'string' ? row.state : 'snoozed'}`)}</span>
      </span>
      {row.surface && (
        <span className="mt-1 flex flex-wrap items-center gap-1">
          <Badge size="sm" tone={row.surface === 'private' ? 'neutral' : 'primary'}>
            {t(`inbox.public.surface.${surfaceKey(row)}`)}
          </Badge>
          {!!row.owed_items && (
            <Badge size="sm" tone="warning">
              {t('inbox.public.owed', { count: row.owed_items })}
            </Badge>
          )}
          {!!row.held_replies && (
            <Badge size="sm" tone="info">
              {t('inbox.public.heldCount', { count: row.held_replies })}
            </Badge>
          )}
          {row.next_deadline && <Deadline at={row.next_deadline} />}
        </span>
      )}
    </Link>
  );
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
  return (
    <>
      <PageHeader
        title={t('inbox.title')}
        description={t('inbox.description')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="ghost"><Link to="/inbox/commissions">{t('inbox.commissions.title')}</Link></Button>
            {manage && <Button asChild size="sm" variant="ghost">
              <Link to="/inbox/merges">{t('inbox.merges.title')}</Link>
            </Button>}
          </div>
        }
      />
      <div
        data-testid="inbox-columns"
        className="grid min-h-[calc(100dvh-12rem)] min-w-0 grid-cols-1 items-stretch border-y border-border bg-surface xl:grid-cols-[14rem_minmax(0,1fr)_18rem]"
      >
        <aside className="flex max-h-96 min-w-0 flex-col gap-5 overflow-y-auto border-b border-border bg-surface-muted px-4 py-6 xl:max-h-[calc(100dvh-8rem)] xl:border-b-0 xl:border-r" aria-label={t('inbox.queues')}>
          <h2 className={`text-sm font-medium ${hasSelection ? 'hidden xl:block' : ''}`}>{t('inbox.queues')}</h2>
          {hasSelection && <Button variant="ghost" className="justify-between px-0 xl:hidden" aria-expanded={queueExpanded} aria-controls="inbox-queue-content" onClick={() => setQueueExpanded((value) => !value)}>
            {t('inbox.ux.browseQueues', { defaultValue: 'Kuyruklar ve kişi araması' })}
            <ChevronDown className={`h-4 w-4 ${queueExpanded ? 'rotate-180' : ''}`} aria-hidden="true" />
          </Button>}
          <div id="inbox-queue-content" className={`${hasSelection && !queueExpanded ? 'hidden' : 'flex'} min-h-0 flex-col gap-5 xl:flex`}>
          <div className="grid grid-cols-2 gap-1 xl:grid-cols-1">
            {(['ours', 'unassigned', 'snoozed', 'all'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant="ghost"
                className={`justify-start rounded-none border-l-2 px-3 ${queue === value ? 'border-brand-accent bg-surface font-medium text-foreground' : 'border-transparent'}`}
                aria-pressed={queue === value}
                onClick={() => setQueue(value)}
              >
                {t(`inbox.queue.${value}`)}
              </Button>
            ))}
            <Button
              size="sm"
              className={`col-span-2 justify-start rounded-none border-l-2 px-3 xl:col-span-1 ${queue === 'approvals' ? 'border-brand-accent bg-surface font-medium text-foreground' : 'border-transparent'}`}
              variant="ghost"
              aria-pressed={queue === 'approvals'}
              onClick={() => setQueue('approvals')}
            >
              {t('inbox.public.approvals')}
            </Button>
          </div>
          <label className="flex flex-col gap-2 text-sm font-medium">
            <span className="sr-only">{t('inbox.search')}</span>
            <span className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input className="bg-surface pl-9" type="search" placeholder={t('inbox.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
            </span>
          </label>
          {queue === 'approvals' && !search.trim() ? (
            <QueryState query={pending}>
              {pending.data?.approvals?.map((held) => (
                <Link
                  key={held.outbox_id}
                  data-testid="approval"
                  className="flex flex-col gap-2 border-l-2 border-warning bg-surface px-3 py-4 text-sm focus-visible:ring-2 focus-visible:ring-ring"
                  to={`/inbox/${encodeURIComponent(held.conversation_id)}`}
                >
                  <span className="font-medium">{t('inbox.public.approvalFor')}</span>
                  {held.deadline && <Deadline at={held.deadline} />}
                </Link>
              ))}
              {pending.data && !pending.data.approvals?.length && (
                <p className="text-sm text-muted-foreground">{t('inbox.public.noApprovals')}</p>
              )}
            </QueryState>
          ) : search.trim() ? (
            <QueryState query={people}>
              {people.data?.map((person) => (
                <Link
                  key={person.id}
                  className="border-l-2 border-transparent px-3 py-4 text-sm hover:border-brand-accent hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
                  to={`/inbox?person=${encodeURIComponent(person.id)}`}
                >
                  {personName(t, person)}
                  <span className="block text-xs text-muted-foreground">{person.company}</span>
                </Link>
              ))}
              {people.data?.length === 0 && (
                <div className="space-y-3 rounded-lg bg-surface-muted p-3">
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
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>{t('inbox.empty')}</p>
                  <p className="leading-6">{t('inbox.ux.emptyQueueHint', { defaultValue: 'Başka bir kuyruk seçin veya bir kişiyi arayın. Yeni görüşmeler bağlı müşteri kanallarından buraya gelir.' })}</p>
                </div>
              )}
              {rows.hasNextPage && (
                <Button
                  variant="outline"
                  loading={rows.isFetchingNextPage}
                  onClick={() => void rows.fetchNextPage()}
                >
                  {t('inbox.more')}
                </Button>
              )}
            </QueryState>
          )}
          </div>
        </aside>
        {conversationId ? (
          <InboxConversation
            key={`${session.data?.current_workspace}:${conversationId}`}
            id={conversationId}
          />
        ) : (
          <>
            <section className={conversationClass} aria-label={t('inbox.thread')}>
              <h2 className="font-display text-xl font-normal">
                {selectedPerson.data
                  ? personName(t, selectedPerson.data.person, selectedPerson.data.identities)
                  : t('inbox.thread')}
              </h2>
              {!selectedPerson.data ? (
                <div className="flex min-h-72 flex-col justify-center border-l border-border pl-6">
                  <p className="max-w-sm text-base leading-7 text-muted-foreground">{t('inbox.ux.chooseHint', { defaultValue: 'Kuyruktan bir görüşme seçin. Kişi aramasıyla geçmiş görüşmelere de ulaşabilirsiniz.' })}</p>
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
              <section className={journeyClass}>
                <h2 className="text-sm font-medium">{t('inbox.journey')}</h2>
                <p className="border-l-2 border-border-strong pl-3 text-sm leading-6 text-muted-foreground">{t('inbox.noJourney')}</p>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
