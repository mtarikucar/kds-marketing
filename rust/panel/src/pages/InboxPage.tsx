import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/inbox';
import type { InboxConversationRow, InboxQueue } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { kindLabel } from '@/lib/capabilities';
import { personName } from '@/lib/people';
import { can } from '@/lib/roles';
import { QueryState } from '@/components/QueryState';
import { Button, Callout, Disclosure, Input, PageHeader } from '@/components/ui';
import { InboxCompliance } from './InboxCompliance';
import { InboxErasure } from './InboxErasure';
import { InboxConversation } from './InboxConversation';
import { InboxJourneyPanel } from './InboxJourneyPanel';
import { columnClass, useInboxKey } from './InboxShared';

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
      className={`block min-w-0 rounded-lg border p-3 text-sm focus-visible:ring-2 focus-visible:ring-ring ${conversationId === row.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'}`}
    >
      <span className="block font-medium">{personName(t, person.data?.person, person.data?.identities)}</span>
      <span className="text-xs text-muted-foreground">
        {kindLabel(t, row.kind_key)} · {t(`inbox.state.${typeof row.state === 'string' ? row.state : 'snoozed'}`)}
      </span>
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
  const [queue, setQueue] = useState<InboxQueue>('ours');
  const [search, setSearch] = useState('');
  const rows = useInfiniteQuery({
    queryKey: [...key, 'conversations', queue],
    queryFn: ({ pageParam }) => api.listConversations(queue, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: allowed,
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
        className="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,1.2fr)]"
      >
        <aside className={columnClass} aria-label={t('inbox.queues')}>
          <h2 className="font-semibold">{t('inbox.queues')}</h2>
          <div className="grid grid-cols-2 gap-2">
            {(['ours', 'unassigned', 'snoozed', 'all'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={queue === value ? 'primary' : 'outline'}
                aria-pressed={queue === value}
                onClick={() => setQueue(value)}
              >
                {t(`inbox.queue.${value}`)}
              </Button>
            ))}
          </div>
          <label className="text-sm">
            {t('inbox.search')}
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          {search.trim() ? (
            <QueryState query={people}>
              {people.data?.map((person) => (
                <Link
                  key={person.id}
                  className="rounded-lg border p-3 text-sm hover:bg-muted"
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
              <h2 className="font-semibold">
                {selectedPerson.data
                  ? personName(t, selectedPerson.data.person, selectedPerson.data.identities)
                  : t('inbox.thread')}
              </h2>
              <p className="text-sm text-muted-foreground">{t('inbox.choose')}</p>
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
                <h2 className="font-semibold">{t('inbox.journey')}</h2>
                <p className="text-sm text-muted-foreground">{t('inbox.noJourney')}</p>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
