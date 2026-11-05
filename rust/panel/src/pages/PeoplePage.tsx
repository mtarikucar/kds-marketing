import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronRight, Search, UserRound } from 'lucide-react';
import { searchPeople } from '@/api/inbox';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { Button, Card, CardContent, EmptyState, Field, Input, PageHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { personName } from '@/lib/people';

/** People per page; the server pages with limit/offset in (created_at, id) order. */
export const PEOPLE_PAGE = 50;

/**
 * Every person of the workspace, including those with no conversation yet (imported or added by
 * hand), which no inbox queue shows. Each row opens the person in the inbox.
 */
export function PeoplePage() {
  const { t, i18n } = useTranslation();
  const workspace = useSession().data?.current_workspace;
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const people = useQuery({
    queryKey: ['inbox', workspace, 'people-list', q.trim(), page],
    queryFn: () => searchPeople(q.trim(), PEOPLE_PAGE, page * PEOPLE_PAGE),
    placeholderData: keepPreviousData,
  });
  const rows = people.data ?? [];
  const first = page * PEOPLE_PAGE + 1;
  return (
    <>
      <PageHeader title={t('people.title')} description={t('people.description')} />
      <Card>
        <CardContent className="flex flex-col gap-5 pt-5">
          <div className="max-w-xl">
          <Field label={t('people.search')}>
            {(ids) => (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input
                id={ids.id}
                type="search"
                className="pl-9"
                value={q}
                autoComplete="off"
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(0);
                }}
              />
              </div>
            )}
          </Field>
          </div>
          <QueryState query={people}>
            {rows.length === 0 ? (
              <EmptyState icon={!q.trim() && page === 0 ? <img src="/brand/scenes/team.svg" width="120" height="96" alt="" /> : <Search className="h-8 w-8" />} className="border-0 bg-surface-muted" title={t(q.trim() || page > 0 ? 'people.noMatch' : 'people.empty')} description={t(q.trim() || page > 0 ? 'people.noMatchBody' : 'people.emptyBody')} action={page > 0 ? <Button variant="outline" onClick={() => setPage((value) => value - 1)}>{t('people.previous')}</Button> : q.trim() ? <Button variant="outline" onClick={() => { setQ(''); setPage(0); }}>{t('people.clearSearch')}</Button> : undefined} />
            ) : (
              <>
                <ul className="divide-y divide-border border-y border-border">
                  {rows.map((person) => (
                    <li key={person.id}>
                      <Link
                        to={`/inbox?person=${encodeURIComponent(person.id)}`}
                        className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-2 py-4 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:px-3"
                      >
                        <span className="row-span-2 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface-muted text-muted-foreground sm:row-span-1" aria-hidden="true"><UserRound className="h-4 w-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">{personName(t, person)}</span>
                          {person.company && <span className="block truncate text-sm text-muted-foreground">{person.company}</span>}
                        </span>
                        <span className="col-start-2 row-start-2 text-caption text-muted-foreground sm:col-start-3 sm:row-start-1">
                          {t('people.added', { at: formatDateTime(person.created_at, i18n.language) })}
                        </span>
                        <ChevronRight className="col-start-3 row-span-2 row-start-1 h-4 w-4 text-muted-foreground group-hover:text-primary sm:col-start-4 sm:row-span-1" aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground">
                    {t('people.range', { first, last: first + rows.length - 1 })}
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                      {t('people.previous')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={rows.length < PEOPLE_PAGE}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      {t('people.next')}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </QueryState>
        </CardContent>
      </Card>
    </>
  );
}
