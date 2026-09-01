import { lazy, Suspense, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CalendarDays, ClipboardList, ExternalLink, List, Phone, Trello } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useEntitlements } from '@/features/marketing/hooks/useEntitlements';
import { ErrorBoundary } from '../../../components/ErrorBoundary';
import { RouteFallback } from '../../../components/RouteFallback';
import { PeopleList } from './PeopleList';
import type { SurfacePerson } from './surfacePerson';

/**
 * Lazy, for the reason InboxPage already gives about its config surfaces: the
 * DAILY arrangement is the list, and a session that never leaves it must not
 * pay for the kanban, the month grid and the task table's bundles. The three
 * are also the heaviest components on the surface by a distance — the board
 * alone pulls the forecast, the pipelines read and the whole deal dialog.
 */
const OpportunitiesPage = lazy(() => import('../opportunities/OpportunitiesPage'));
const CalendarPage = lazy(() => import('../calendar/CalendarPage'));
const TasksPage = lazy(() => import('../tasks/TasksPage'));
const CallsPage = lazy(() => import('../CallsPage'));

/**
 * The five arrangements of one set of people. `list` is the default.
 *
 * `calls` keeps its place in this list even for a workspace that is not
 * telephony-entitled, and that is deliberate: the TAB is gated (below), the
 * VALUE is not, so a stale `?left=calls` still resolves to a known view rather
 * than leaving `isLeftView` false and the column rendering nothing.
 */
export const LEFT_VIEWS = ['list', 'board', 'calendar', 'tasks', 'calls'] as const;

/**
 * The route each arrangement is an embedded copy of, and the door back to it.
 *
 * `list` is deliberately absent: that view IS this page (`/leads`), and a
 * control offering to open the page you are already on is the kind of dead
 * affordance that teaches people to stop reading the chrome.
 *
 * The other three need it as of stage 4 (2026-09-01), which takes them out of
 * the menu. Embedding keeps every capability except the pages' own chrome —
 * with one real exception worth the link on its own: `CalendarPage` renders the
 * seven-column month GRID only when it is NOT embedded (Tailwind v3 has no
 * container queries, so its `md:` breakpoints read the viewport and the grid
 * collapses to ~85px cells inside this column). `?create=1`, which the global
 * "+ Create" menu deep-links, is also disabled while embedded.
 */
const FULL_PAGE: Partial<Record<(typeof LEFT_VIEWS)[number], string>> = {
  board: '/opportunities',
  calendar: '/calendar',
  tasks: '/tasks',
  calls: '/calls',
};
export type LeftView = (typeof LEFT_VIEWS)[number];
export const isLeftView = (v: string | null): v is LeftView =>
  (LEFT_VIEWS as readonly string[]).includes(v ?? '');

export interface PeopleColumnProps {
  view: LeftView;
  onView: (v: LeftView) => void;
  /** Who the other two columns are showing; null before anyone is picked. */
  selectedId: string | null;
  /**
   * A SELECTION, never a navigation — the same contract `PeopleList` has had
   * since this surface replaced its two tabs.
   *
   * The row may be PARTIAL. `PeopleList` hands over the whole person because it
   * has just rendered them from `GET /leads`; a board card carries a name and a
   * phone, a task row carries a business name. The surface resolves the rest
   * against the person's own record — see InboxPage.
   */
  onSelect: (person: SurfacePerson) => void;
  className?: string;
}

/**
 * The left column, and the switch between the five ways it arranges the same
 * people: **Liste · Hat · Takvim · Görevler · Aramalar** (2026-09-01 design,
 * "Karar 1", plus the calls arrangement).
 *
 * The middle column (the person's stream) and the right column (their record
 * card) are untouched by the switch, and the SELECTION survives it — that pair
 * of facts is the whole design. Clicking a deal on the pipeline and reading
 * that person's conversation without leaving the screen is the thing being
 * bought; a switcher that dropped the selection would just be navigation with
 * extra steps, which is what this surface stopped doing in v2.284.0.
 *
 * ## Why the three views are the PAGES, embedded
 *
 * `/opportunities`, `/calendar` and `/tasks` each take the `embedded` prop this
 * codebase already uses on LeadsPage, ChannelsSettingsPage, SnippetsPage,
 * OffersTab and TasksTab: only the CHROME is a prop. Every column, dialog,
 * drag handler and mutation is the same code, so the brief's hardest constraint
 * — "hiçbir özelliği kaybetmeden" — is satisfied by construction rather than by
 * a checklist, and the eight frozen routes keep resolving to the very same
 * components.
 *
 * ## Gates: four of the five need none, and that was checked rather than assumed
 *
 * `GET /leads` (Liste), `/opportunities/*` (Hat), `/tasks/calendar` (Takvim) and
 * `/tasks` (Görevler) carry no `@RequiresFeature` and no `@MarketingRoles` on
 * their reads; the services scope a REP to their own rows instead. So those four
 * are offered to everyone who can reach the surface, and none is a plan line
 * that has to be NAMED. The one place that rule bites is Takvim, where
 * `/appointments` would have been the other candidate and is `managerOnly` +
 * `funnels` — see CalendarPage's docstring for why that ruled it out.
 *
 * Aramalar IS gated, and it is the exception that proves the rule was checked
 * rather than assumed: `/calls` carries `feature: 'telephony'` in navigation.ts
 * and the wallboard inside it 503s without an active Netsantral config. The
 * tab is withheld from an unentitled workspace and a stale `?left=calls` falls
 * back to Liste — `LEFT_VIEWS` keeps the value either way, so the parameter
 * still RESOLVES instead of blanking the column.
 *
 * ## Each view fails in its own column
 *
 * The layout's `ErrorBoundary` is keyed on the ROUTE, so a view that throws
 * while rendering — which is the shape a failed lazy chunk takes — would take
 * the stream and the record card down with it and leave the whole surface
 * reading "Something went wrong". The boundary here is keyed on the VIEW: it
 * clears when you switch away, it names the arrangement that failed, and the
 * other two columns never notice.
 */
export function PeopleColumn({
  view,
  onView,
  selectedId,
  onSelect,
  className,
}: PeopleColumnProps) {
  const { t } = useTranslation('marketing');
  /**
   * The one arrangement that carries a gate. `/calls` is `feature: 'telephony'`
   * in navigation.ts and the queue wallboard behind it 503s without an active
   * Netsantral config, so an unentitled workspace is offered a tab that cannot
   * work. `has()` fails CLOSED while the billing summary is in flight, which is
   * the right way round: a tab that appears a beat late is better than one that
   * appears and then vanishes.
   */
  const { has: hasFeature } = useEntitlements();
  const tabs = LEFT_VIEWS.filter((v) => v !== 'calls' || hasFeature('telephony'));
  /**
   * A `?left=` value the workspace is no longer entitled to falls back to
   * Liste, the same rule InboxPage applies to an unknown `?tab=`. Hiding only
   * the TAB would leave a bookmarked `?left=calls` rendering a column whose
   * every request 503s, with no lit tab and no way to see what happened.
   */
  const active: LeftView = (tabs as readonly LeftView[]).includes(view) ? view : 'list';

  const label: Record<LeftView, string> = {
    list: t('surface.view.list', 'Liste'),
    board: t('surface.view.board', 'Hat'),
    calendar: t('surface.view.calendar', 'Takvim'),
    tasks: t('surface.view.tasks', 'Görevler'),
    calls: t('surface.view.calls', 'Aramalar'),
  };
  const icon: Record<LeftView, ReactNode> = {
    list: <List className="h-3.5 w-3.5" aria-hidden="true" />,
    board: <Trello className="h-3.5 w-3.5" aria-hidden="true" />,
    calendar: <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />,
    tasks: <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />,
    calls: <Phone className="h-3.5 w-3.5" aria-hidden="true" />,
  };

  /**
   * The one place the three embedded pages' person shapes become the surface's.
   *
   * They differ: a board card is a `PersonCard` (nullable `businessName`,
   * `contactPerson`, `phone` plus fields the surface has no use for), a task row
   * is `{ id, businessName }`. The parameter is the widest of them so this
   * function is assignable to all three `onSelectPerson` props.
   *
   * NULLS ARE DROPPED, and that is the point rather than tidiness.
   * `SurfacePerson` is a Partial, where absent means "nobody has said" and the
   * record card is held to not filling that silence in — carrying a
   * `businessName: null` through would turn a field the payload genuinely does
   * not set into one the surface has been told about.
   */
  const report = (p: {
    id: string;
    businessName?: string | null;
    contactPerson?: string | null;
    phone?: string | null;
  }) =>
    onSelect({
      id: p.id,
      ...(p.businessName ? { businessName: p.businessName } : {}),
      ...(p.contactPerson ? { contactPerson: p.contactPerson } : {}),
      ...(p.phone ? { phone: p.phone } : {}),
    });

  /**
   * ALL FOUR views are inside the boundary, Liste included.
   *
   * It used to be the one that was not: the list was the original column and
   * the boundary arrived with the three that came later, so a `PeopleList`
   * that threw escaped to the ROUTE boundary and took the whole surface —
   * both other columns, the open person, the composer — down with it, over the
   * failure of one third of one column. The three lazy views degraded to a
   * retry button in place and the list did not, which is backwards: Liste is
   * where a session starts and the one view a user cannot switch away from
   * before it has rendered.
   *
   * Stage 3 puts group-by-company inside this branch, i.e. new grouping logic
   * exactly where the missing boundary was, so this is cheaper to do now than
   * to remember then.
   */
  const body = (
    <ErrorBoundary
      // Keyed on the view: switching away clears a failure rather than
      // stranding the column on it.
      key={active}
      fallback={(retry) => (
        <div
          data-testid="view-failed"
          role="alert"
          className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface py-10"
        >
          {/* By NAME. "A view broke" and "the Hat view broke" are different
              sentences to somebody who has three others to fall back to. */}
          <p className="text-sm text-danger">
            {label[active]} — {t('surface.view.failed', 'Bu görünüm açılamadı.')}
          </p>
          <Button variant="outline" size="sm" onClick={retry}>
            {t('common.retry', 'Tekrar dene')}
          </Button>
        </div>
      )}
    >
      {/* The list is a direct import, so it needs no Suspense of its own —
          only the three borrowed pages are lazy chunks. */}
      {active === 'list' ? (
        <PeopleList selectedId={selectedId} onSelect={onSelect} className="w-full" />
      ) : (
        <Suspense fallback={<RouteFallback />}>
          {active === 'board' ? (
            <OpportunitiesPage embedded selectedLeadId={selectedId} onSelectPerson={report} />
          ) : active === 'calendar' ? (
            <CalendarPage embedded selectedLeadId={selectedId} onSelectPerson={report} />
          ) : active === 'calls' ? (
            <CallsPage embedded selectedLeadId={selectedId} onSelectPerson={report} />
          ) : (
            <TasksPage embedded selectedLeadId={selectedId} onSelectPerson={report} />
          )}
        </Suspense>
      )}
    </ErrorBoundary>
  );

  const fullPage = FULL_PAGE[active];

  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className ?? ''}`}>
      <div className="flex shrink-0 items-center gap-1.5">
      <div
        role="tablist"
        aria-label={t('surface.view.label', 'Görünüm')}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-border p-1"
      >
        {tabs.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active === v}
            data-testid={`view-tab-${v}`}
            onClick={() => onView(v)}
            className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              active === v
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground'
            }`}
          >
            {icon[v]}
            {label[v]}
          </button>
        ))}
      </div>
      {/* OUTSIDE the tablist: it is not a fifth arrangement, and a link inside
          a `role="tablist"` is a child with no `role="tab"` — which screen
          readers are entitled to drop. The accessible name carries the view's
          own name, so four identical "Tam sayfa aç" links can never be what a
          user hears. */}
      {fullPage && (
        <Link
          to={fullPage}
          aria-label={`${label[active]} — ${t('surface.view.fullPage', 'Tam sayfa aç')}`}
          title={t('surface.view.fullPage', 'Tam sayfa aç')}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}
      </div>

      {/* The list owns its own scrolling (it has a sticky filter row and a
          pager); the three embedded pages are ordinary documents, so the column
          scrolls them. */}
      <div className={`min-h-0 flex-1 ${active === 'list' ? 'flex' : 'overflow-auto'}`}>{body}</div>
    </div>
  );
}
