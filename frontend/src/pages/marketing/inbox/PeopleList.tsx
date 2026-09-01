import { Fragment, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, Search } from 'lucide-react';
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
 *
 * ## Grouping by company (`?group=company`)
 *
 * `Şirketler` is not a field of a person — `Company` has no `leadId` — so it
 * could not become a section of the record card the way Görevler and Teklifler
 * did. Per the owner's decision it is a GROUPING of this list instead, and
 * `/companies` keeps its route and every capability it has.
 *
 * **The grouping is an ORDER, not a bucketing of this page.** The toggle asks
 * the server for `sortBy=company`, which ranks the whole filtered set so a
 * company's people are contiguous, and the page is a window onto that ranking.
 * Bucketing the 25 rows already in hand would have needed no backend at all —
 * and it would have lied: this list is paginated, so a company's people are
 * scattered, and a header reading "Acme · 3" over a company with forty
 * contacts is worse than no grouping, on the very surface that is replacing
 * `/companies`'s menu entry. That is also why a header carries a NAME and no
 * count: the page cannot know the company's total, and `/companies` can.
 *
 * A person with no company gets a NAMED trailing block ("Şirketsiz"), never a
 * silent omission — dropping the unlinked is the exact failure this surface
 * exists to prevent, and they are the majority in most workspaces. The server
 * ranks them last for the same reason; see `MarketingLeadsService.findAll`.
 *
 * A grouping is not a filter: the chips, the search and the pager all keep
 * working while it is on, and turning it off restores the activity sort.
 */
export function PeopleList({ selectedId, onSelect, className }: PeopleListProps) {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();

  const assignmentStatus = params.get('assignmentStatus') ?? '';
  const waiting = params.get('waiting') === '1';
  // Two states, so one toggle. Any other value is "not grouped" rather than a
  // blank column — the same rule `?left=` and `?tab=` follow on this surface.
  const groupByCompany = params.get('group') === 'company';
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

  const toggleGroup = () => {
    setPage(1);
    setParams(
      (p) => {
        if (groupByCompany) p.delete('group');
        else p.set('group', 'company');
        return p;
      },
      { replace: true },
    );
  };

  // A new filter is a new first page; without this a search from page 4 asks
  // for page 4 of a set that may have three. Regrouping is the same kind of
  // event: page 4 of the activity order and page 4 of the company order are
  // different people.
  useEffect(() => setPage(1), [search]);

  const queueParams = LEAD_QUEUE_PARAMS[activeQueue ?? 'all'];
  const listParams = {
    search: search || undefined,
    // A queue the chips do not describe still has to reach the backend, or the
    // deep link would silently widen to "everyone".
    ...(activeQueue ? queueParams : { assignmentStatus }),
    // The owner's sort. Spelled at the call site rather than defaulted server
    // side, so reading this file tells you what order the column is in.
    //
    // `company` REPLACES it rather than stacking with it, because it is the
    // same axis: the server ranks by company name and then, inside a company,
    // by that very activity — so the owner's order survives within each block.
    // `sortOrder` is omitted while grouping on purpose: the server does not
    // consult it there (groups are always A-Z, the ungrouped always last), and
    // sending a parameter that decides nothing invites the next reader to
    // believe it does.
    sortBy: groupByCompany ? ('company' as const) : ('lastActivityAt' as const),
    ...(groupByCompany ? {} : { sortOrder: 'desc' as const }),
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
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
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
          {/* `aria-pressed` and not `aria-current`: this IS a two-state toggle
              (grouped / not), unlike a row, which is "which of these is
              showing". The accessible name is the whole sentence; the visible
              label is one word, because the column is ~384px wide. */}
          <button
            type="button"
            data-testid="group-toggle"
            aria-pressed={groupByCompany}
            aria-label={t('surface.people.group.byCompany', 'Şirkete göre grupla')}
            title={t('surface.people.group.byCompany', 'Şirkete göre grupla')}
            onClick={toggleGroup}
            className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
              groupByCompany
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border-strong text-muted-foreground hover:bg-surface-muted hover:text-foreground'
            }`}
          >
            <Building2 className="h-4 w-4" aria-hidden="true" />
            {t('surface.people.group.short', 'Şirket')}
          </button>
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
              {people.map((p, i) => {
                // The server already returned the page in group order, so a
                // header is simply "the company changed since the row above".
                // The client never RE-sorts: it could only sort the 25 rows it
                // holds, which would fight the ranking the page was cut from.
                //
                // "Changed" is measured on the NAME, because the name is what
                // the server grouped on (`sortBy=company` compares the resolved
                // company name, and treats an unnameable id as no group at
                // all). Keyed on the ID instead, two DIFFERENT companies that
                // share a name — a chain's two branch records, or a duplicate
                // two reps created on the same day — arrive as one contiguous
                // run from the server and got two consecutive, identical
                // headers here: a boundary the client invented, reading as two
                // blocks of the same company.
                const groupName = p.company?.name ?? null;
                const opensGroup =
                  groupByCompany &&
                  (i === 0 || (people[i - 1].company?.name ?? null) !== groupName);
                // The test id still names the company this block OPENED with —
                // an id is stable and safe in a selector where a name is
                // neither. It identifies the block, not its membership.
                const groupId = p.company?.id ?? null;
                return (
                  <Fragment key={p.id}>
                    {opensGroup && (
                      <li
                        data-testid={`people-group-${groupId ?? 'none'}`}
                        className="sticky top-0 z-[1] bg-surface-muted px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {/* A NAME and no count. This page cannot know how many
                            contacts the company has — only how many landed on
                            this page — and a number that means the second while
                            reading as the first is the failure this grouping
                            was built to avoid. `/companies` has the count. */}
                        {p.company?.name ?? t('surface.people.group.none', 'Şirketsiz')}
                      </li>
                    )}
                    <li>
                      <PersonRow
                        person={p}
                        selected={p.id === selectedId}
                        onSelect={onSelect}
                        silentLabel={t('surface.people.silent', 'Henüz konuşulmadı')}
                      />
                    </li>
                  </Fragment>
                );
              })}
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
