import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
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
import { Deadline, columnClass, useInboxKey } from './InboxShared';

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
      className={`block min-w-0 rounded-lg border-l-[3px] p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${conversationId === row.id ? 'border-primary bg-surface-muted' : 'border-transparent hover:border-border-strong hover:bg-surface-muted'}`}
    >
      <span className="block font-medium">{personName(t, person.data?.person, person.data?.identities)}</span>
      <span className="text-xs text-muted-foreground">
        {kindLabel(t, row.kind_key)} · {t(`inbox.state.${typeof row.state === 'string' ? row.state : 'snoozed'}`)}
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
            <Button asChild variant="outline"><Link to="/inbox/commissions">{t('inbox.commissions.title')}</Link></Button>
            {manage && <Button asChild variant="outline">
              <Link to="/inbox/merges">{t('inbox.merges.title')}</Link>
            </Button>}
          </div>
        }
      />
      <div
        data-testid="inbox-columns"
        className="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(220px,0.85fr)_minmax(0,1.7fr)_minmax(250px,1fr)]"
      >
        <aside className={`${columnClass} max-h-[28rem] overflow-y-auto xl:sticky xl:top-4 xl:max-h-[calc(100dvh-9rem)]`} aria-label={t('inbox.queues')}>
          <h2 className="font-display text-h3">{t('inbox.queues')}</h2>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-muted p-1">
            {(['ours', 'unassigned', 'snoozed', 'all'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={queue === value ? 'primary' : 'ghost'}
                aria-pressed={queue === value}
                onClick={() => setQueue(value)}
              >
                {t(`inbox.queue.${value}`)}
              </Button>
            ))}
            <Button
              size="sm"
              className="col-span-2"
              variant={queue === 'approvals' ? 'primary' : 'ghost'}
              aria-pressed={queue === 'approvals'}
              onClick={() => setQueue('approvals')}
            >
              {t('inbox.public.approvals')}
            </Button>
          </div>
          <label className="flex flex-col gap-2 text-sm font-medium">
            {t('inbox.search')}
            <span className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input className="pl-9" type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
            </span>
          </label>
          {queue === 'approvals' && !search.trim() ? (
            <QueryState query={pending}>
              {pending.data?.approvals?.map((held) => (
                <Link
                  key={held.outbox_id}
                  data-testid="approval"
                  className="flex flex-col gap-2 rounded-lg border-l-[3px] border-warning bg-warning-subtle p-3 text-sm focus-visible:ring-2 focus-visible:ring-ring"
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
                  className="rounded-lg border-l-[3px] border-transparent p-3 text-sm hover:border-border-strong hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-ring"
                  to={`/inbox?person=${encodeURIComponent(person.id)}`}
                >
                  {personName(t, person)}
                  <span className="block text-xs text-muted-foreground">{person.company}</span>
                </Link>
              ))}
              {people.data?.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('inbox.empty')}</p>
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
                <p className="text-sm text-muted-foreground">{t('inbox.empty')}</p>
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
        </aside>
        {conversationId ? (
          <InboxConversation
            key={`${session.data?.current_workspace}:${conversationId}`}
            id={conversationId}
          />
        ) : (
          <>
            <section className={columnClass} aria-label={t('inbox.thread')}>
              <h2 className="font-display text-h3">
                {selectedPerson.data
                  ? personName(t, selectedPerson.data.person, selectedPerson.data.identities)
                  : t('inbox.thread')}
              </h2>
              {!selectedPerson.data ? (
                <div className="flex min-h-72 flex-col items-center justify-center gap-5 px-4 py-8 text-center">
                  <img src="/brand/scenes/conversations.svg" width="120" height="96" alt="" aria-hidden="true" />
                  <p className="max-w-xs text-sm leading-6 text-muted-foreground">{t('inbox.choose')}</p>
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
              <section className={columnClass}>
                <h2 className="font-display text-h3">{t('inbox.journey')}</h2>
                <p className="border-l-2 border-border-strong pl-3 text-sm leading-6 text-muted-foreground">{t('inbox.noJourney')}</p>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
