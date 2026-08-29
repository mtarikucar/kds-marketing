import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  LeadQueueChips,
  LEAD_QUEUE_PARAMS,
  useLeadQueueCounts,
  type LeadQueue,
} from '../../../features/marketing/components';
import { listLeads } from '../../../features/marketing/api/leads.service';
import type { Lead } from '../../../features/marketing/types';
import { fmtSlot } from '../../../features/marketing/utils/format';

/**
 * How many people one screenful of the list holds. Bigger than the leads
 * table's 20 because a row here is one line rather than a table row with eight
 * columns, and the point of this column is to scroll rather than to paginate.
 */
const LIMIT = 25;

export interface PeopleListProps {
  /** Who is open in the other two columns; null before anyone is picked. */
  selectedId: string | null;
  /**
   * A SELECTION, never a navigation. See the file docstring.
   *
   * The whole record rather than an id: the list has just rendered this row
   * from the server's own payload, and making the surface look the person up
   * again would put a second answer to "who is this" beside the first.
   */
  onSelect: (person: Lead) => void;
  className?: string;
}

/**
 * The left column: one list, and the object in it is a PERSON.
 *
 * The correction this file carries is small to state and was the whole mistake
 * in v2.283.0: **clicking a row selects, it does not navigate.** That version
 * put the conversation list and the contact list on one page as two tabs, and a
 * click in the contacts tab still went to `/leads/:id` — so they stayed two
 * objects with two behaviours, moved rather than merged. A row here reports a
 * selection to the surface, which opens that person's stream in the middle
 * column and their record card on the right. The only navigation on the whole
 * surface is the record card's link into `/leads/:id` for deep work.
 *
 * Two consequences worth spelling out:
 *
 * 1. **The default order is `lastActivityAt` desc**, the owner's own decision.
 *    The backend guarantees that field is never null (it falls back through the
 *    newest activity to the lead's own `createdAt`), which is the only reason
 *    ONE sort can carry both the people with conversations and the ~363 who
 *    have never had one. The talkative rise; the silent settle underneath in
 *    arrival order.
 *
 * 2. **The chips, not the sort, are what keep the silent ones reachable.**
 *    That is the answer to "a single list hides the quiet leads": `Atanmamış`
 *    brings them to the top in one press. They are shared with the leads table
 *    (LeadQueueChips) so `Bekleyen` cannot drift from what the morning digest
 *    means.
 *
 * The queue lives in the URL rather than in local state, for the same two
 * reasons the leads table does it: `/leads?assignmentStatus=unassigned` is a
 * live deep link from the dashboard (NeedsAttention, DashboardHero), and a
 * filtered queue is worth pasting to a colleague.
 */
export function PeopleList({ selectedId, onSelect, className }: PeopleListProps) {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();

  const assignmentStatus = params.get('assignmentStatus') ?? '';
  const waiting = params.get('waiting') === '1';
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // Same three-way read the leads table does. A view none of the three chips
  // describes (e.g. `assignmentStatus=mine`) lights no chip — which is the
  // truth, not a bug.
  const activeQueue: LeadQueue | null = waiting
    ? 'waiting'
    : assignmentStatus === 'unassigned'
      ? 'unassigned'
      : assignmentStatus === ''
        ? 'all'
        : null;

  const selectQueue = (q: LeadQueue) => {
    setPage(1);
    setParams(
      (p) => {
        if (q === 'waiting') p.set('waiting', '1');
        else p.delete('waiting');
        if (q === 'unassigned') p.set('assignmentStatus', 'unassigned');
        else p.delete('assignmentStatus');
        return p;
      },
      { replace: true },
    );
  };

  // A new filter is a new first page; without this a search from page 4 asks
  // for page 4 of a set that may have three.
  useEffect(() => setPage(1), [search]);

  const queueParams = LEAD_QUEUE_PARAMS[activeQueue ?? 'all'];
  const listParams = {
    search: search || undefined,
    // A queue the chips do not describe still has to reach the backend, or the
    // deep link would silently widen to "everyone".
    ...(activeQueue ? queueParams : { assignmentStatus }),
    // The owner's sort. Spelled at the call site rather than defaulted server
    // side, so reading this file tells you what order the column is in.
    sortBy: 'lastActivityAt',
    sortOrder: 'desc' as const,
    page,
    limit: LIMIT,
  };

  const q = useQuery({
    queryKey: ['marketing', 'leads', listParams],
    queryFn: () => listLeads(listParams),
  });

  const counts = useLeadQueueCounts({ search: search || undefined }, activeQueue);

  const people = q.data?.data ?? [];

  return (
    <Card className={`flex flex-col overflow-hidden ${className ?? ''}`}>
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <LeadQueueChips
          active={activeQueue}
          counts={counts}
          activeTotal={q.data?.meta.total}
          onSelect={selectQueue}
        />
        <div className="relative">
          <Search
            className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('surface.people.search', 'Kişi ara')}
            placeholder={t('surface.people.search', 'Kişi ara')}
            className="h-9 w-full rounded-lg border border-border-strong bg-surface ps-8 pe-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* A broken list and an empty one are different screens: the boundary
            owns the failure (named, with a retry) and the empty state is only
            reachable once the query has settled healthy. */}
        <QueryStateBoundary
          isError={q.isError}
          onRetry={() => q.refetch()}
          errorMessage={t('surface.people.loadFailed', 'Kişiler yüklenemedi.')}
          retryLabel={t('common.retry', 'Tekrar dene')}
          isLoading={q.isLoading}
          loading={
            <div className="space-y-2 p-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-14 rounded-lg" />
              ))}
            </div>
          }
        >
          {people.length === 0 ? (
            <div className="p-3">
              <EmptyState
                data-testid="people-empty"
                title={t('surface.people.empty.title', 'Bu kuyrukta kimse yok')}
                description={t(
                  'surface.people.empty.desc',
                  'Başka bir kuyruk seç ya da aramayı temizle.',
                )}
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {people.map((p) => (
                <li key={p.id}>
                  <PersonRow
                    person={p}
                    selected={p.id === selectedId}
                    onSelect={onSelect}
                    silentLabel={t('surface.people.silent', 'Henüz konuşulmadı')}
                  />
                </li>
              ))}
            </ul>
          )}
        </QueryStateBoundary>
      </div>

      {q.data && q.data.meta.totalPages > 1 && (
        <div className="shrink-0 border-t border-border p-2">
          <Pagination page={page} pageCount={q.data.meta.totalPages} onPage={setPage} />
        </div>
      )}
    </Card>
  );
}

/**
 * One person, one line.
 *
 * A `<button>` and not an `<a>`, deliberately and testably: an anchor is a
 * navigation waiting to happen, and this row's whole job is to be the thing
 * that finally stopped navigating.
 */
function PersonRow({
  person,
  selected,
  onSelect,
  silentLabel,
}: {
  person: Lead;
  selected: boolean;
  onSelect: (person: Lead) => void;
  silentLabel: string;
}) {
  const name = person.contactPerson || person.businessName;
  const unread = person.unreadCount ?? 0;

  return (
    <button
      type="button"
      data-testid={`person-row-${person.id}`}
      // `aria-current` rather than `aria-pressed`: this is "which of these is
      // showing", not a toggle. Published either way so the three columns can
      // be asserted to agree about who is open.
      aria-current={selected}
      onClick={() => onSelect(person)}
      className={`w-full px-3 py-2.5 text-start transition-colors hover:bg-surface-muted ${
        selected ? 'bg-primary/5' : ''
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {fmtSlot(person.lastActivityAt)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2">
        {/* A person with no thread says so rather than showing a blank line —
            silence is information here, and it is what the composer in the
            middle column is about to offer to end. */}
        <span
          className={`truncate text-xs ${
            person.lastMessagePreview ? 'text-muted-foreground' : 'text-muted-foreground/60 italic'
          }`}
        >
          {person.lastMessagePreview || silentLabel}
        </span>
        {unread > 0 && (
          <Badge data-testid={`person-unread-${person.id}`} tone="primary" size="sm">
            {unread}
          </Badge>
        )}
      </div>
    </button>
  );
}
