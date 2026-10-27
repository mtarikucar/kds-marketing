import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { searchPeople } from '@/api/inbox';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import { Button, Card, CardContent, EmptyState, Field, Input, PageHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

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
        <CardContent className="flex flex-col gap-4 pt-6">
          <Field label={t('people.search')}>
            {(ids) => (
              <Input
                id={ids.id}
                value={q}
                autoComplete="off"
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(0);
                }}
              />
            )}
          </Field>
          <QueryState query={people}>
            {rows.length === 0 ? (
              <EmptyState title={t(q.trim() ? 'people.noMatch' : 'people.empty')} description={t('people.emptyBody')} />
            ) : (
              <>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {rows.map((person) => (
                    <li key={person.id}>
                      <Link
                        to={`/inbox?person=${encodeURIComponent(person.id)}`}
                        className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 hover:bg-surface-muted"
                      >
                        <span>
                          <span className="font-medium text-foreground">{person.display_name}</span>
                          {person.company && <span className="text-muted-foreground"> · {person.company}</span>}
                        </span>
                        <span className="text-caption text-muted-foreground">
                          {t('people.added', { at: formatDateTime(person.created_at, i18n.language) })}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between gap-2 text-sm">
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
