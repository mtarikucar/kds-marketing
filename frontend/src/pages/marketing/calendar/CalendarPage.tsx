import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import type { MarketingTask, MarketingUserInfo } from '../../../features/marketing/types';
import type { TaskFormValues } from '../../../features/marketing/schemas';
import { localDateTimeToIso } from '../../../features/marketing/utils/datetime';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import {
  PageHeader,
  Card,
  CardContent,
  Button,
  IconButton,
  QueryStateBoundary,
  Skeleton,
} from '@/components/ui';
import { CalendarGrid } from './CalendarGrid';
import { CalendarAgenda } from './CalendarAgenda';
import { DayDialog } from './DayDialog';

function toLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

interface RepRow extends MarketingUserInfo {
  role: string;
}

export interface CalendarPageProps {
  /**
   * Rendered inside another page's surface rather than at `/calendar`.
   *
   * Swaps the page CHROME for the host's, and lays the month out as the AGENDA
   * rather than the seven-column grid — see the render for why that is a layout
   * choice and not a lost capability. The month navigation, the day dialog and
   * the create mutation are the same code.
   */
  embedded?: boolean;
  /** Report the person a task belongs to, instead of doing nothing with it. */
  onSelectPerson?: (person: NonNullable<MarketingTask['lead']>) => void;
  /** Who the host has open, so this month can mark their tasks. */
  selectedLeadId?: string | null;
}

/**
 * The month calendar of TASKS (`GET /tasks/calendar`). Also the person
 * surface's **Takvim** view (2026-09-01 design, stage 2).
 *
 * ## Why this page is the surface's Takvim and `/appointments` is not
 *
 * "Takvim" could have meant either. `MarketingBookingController` — which
 * `/appointments` reads — is `@MarketingRoles('MANAGER')` +
 * `@RequiresFeature('funnels')`, and `navigation.ts` marks that entry
 * `managerOnly` with `feature: 'funnels'` to match. Sourcing a whole VIEW of
 * the surface from there would put one of its four arrangements behind a role a
 * rep cannot buy out of AND a plan line most workspaces have not bought.
 * `/tasks/calendar` carries neither gate (no `@MarketingRoles`, no
 * `@RequiresFeature` on the read; the service scopes a REP to their own rows
 * instead), so every user who can reach the surface can reach this view.
 *
 * The person's RANDEVULAR are not lost by that choice: they are on the record
 * card, behind their own two gates, as stage 1 shipped them — and `/appointments`
 * still resolves at its own URL.
 */
export default function CalendarPage({
  embedded,
  onSelectPerson,
  selectedLeadId,
}: CalendarPageProps = {}) {
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation('marketing');
  const locale = i18n.language || 'tr';

  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const { data: reps = [] } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    enabled: isManager,
    staleTime: 60_000,
  });

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // Send LOCAL date-only bounds (YYYY-MM-DD), not UTC instants. The grid
  // buckets tasks by `toLocalDateKey`, so the fetch window has to be the same
  // local calendar month — using `.toISOString()` here shifted the bounds by
  // the timezone offset and could drop the first/last day's tasks for users
  // east/west of UTC.
  const dateFrom = toLocalDateKey(new Date(year, month, 1));
  const dateTo = toLocalDateKey(new Date(year, month + 1, 0));

  const { data: tasks, isLoading, isError, refetch } = useQuery({
    queryKey: ['marketing', 'tasks', 'calendar', year, month],
    queryFn: () =>
      marketingApi
        .get('/tasks/calendar', { params: { dateFrom, dateTo } })
        .then((r) => r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => marketingApi.post('/tasks', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'tasks'] });
      // The task belongs to somebody, and on the person surface their record
      // card is two columns away. Same round trip, and the same PREFIX reason,
      // as TasksPage's own invalidate.
      queryClient.invalidateQueries({ queryKey: ['marketing', 'lead'] });
      setSelectedDate(null);
      toast.success('Task created');
    },
    onError: () => {
      toast.error('Failed to create task');
    },
  });

  // Build 42-cell grid (6 weeks × 7 days) padded with prev/next month days
  const calendarDays = useMemo(() => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startPad = firstDay.getDay(); // 0=Sun
    const days: { date: Date; isCurrentMonth: boolean }[] = [];

    // Previous month padding
    for (let i = startPad - 1; i >= 0; i--) {
      const d = new Date(year, month, -i);
      days.push({ date: d, isCurrentMonth: false });
    }

    // Current month
    for (let d = 1; d <= lastDay.getDate(); d++) {
      days.push({ date: new Date(year, month, d), isCurrentMonth: true });
    }

    // Next month padding
    const remaining = 42 - days.length;
    for (let d = 1; d <= remaining; d++) {
      days.push({ date: new Date(year, month + 1, d), isCurrentMonth: false });
    }

    return days;
  }, [year, month]);

  const tasksByDate = useMemo(() => {
    const map: Record<string, MarketingTask[]> = {};
    if (tasks) {
      (tasks as MarketingTask[]).forEach((task) => {
        const key = toLocalDateKey(new Date(task.dueDate));
        if (!map[key]) map[key] = [];
        map[key].push(task);
      });
    }
    return map;
  }, [tasks]);

  const goToMonth = (delta: number) => {
    setCurrentDate(new Date(year, month + delta, 1));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const openDayModal = (dateKey: string) => {
    setSelectedDate(dateKey);
  };

  const monthName = currentDate.toLocaleString(locale, { month: 'long', year: 'numeric' });

  const weekdayShort = t('calendar.weekdayShort', { returnObjects: true }) as string[];

  const selectedDayTasks = selectedDate ? (tasksByDate[selectedDate] || []) : [];

  const currentMonthDays = calendarDays.filter((d) => d.isCurrentMonth);

  return (
    <div className="space-y-4">
      {!embedded && (
        <PageHeader title={t('calendar.title')} description={t('calendar.subtitle')} />
      )}

      {/* Navigation bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <IconButton
                aria-label={t('calendar.prevMonth', { defaultValue: 'Previous month' })}
                variant="ghost"
                onClick={() => goToMonth(-1)}
              >
                <ChevronLeft className="h-5 w-5" />
              </IconButton>
              <IconButton
                aria-label={t('calendar.nextMonth', { defaultValue: 'Next month' })}
                variant="ghost"
                onClick={() => goToMonth(1)}
              >
                <ChevronRight className="h-5 w-5" />
              </IconButton>
            </div>

            <h2 className="text-lg font-semibold text-foreground capitalize">{monthName}</h2>

            <Button variant="outline" size="sm" onClick={goToToday}>
              {t('calendar.today', { defaultValue: 'Today' })}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* A month that could not be READ and a month with nothing due are
          different answers, and this page used to give them the same one: it
          read `isLoading` alone, so a failed /tasks/calendar drew an empty
          month. On a calendar that is the most expensive thing to get wrong. */}
      <QueryStateBoundary
        isLoading={isLoading}
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('calendar.loadFailed', { defaultValue: 'Could not load the calendar.' })}
        retryLabel={t('common.retry', { defaultValue: 'Retry' })}
        loading={
          <div className="rounded-xl border border-border bg-surface p-4 grid grid-cols-7 gap-1">
            {Array.from({ length: 35 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        }
      >
        {/* Desktop month grid — NOT when embedded. Tailwind v3 has no container
            queries, so this component's `hidden md:block` reads the VIEWPORT:
            inside the surface's ~40% left column on a desktop the seven columns
            still render, at about 85px a cell, with every task title truncated
            to nothing. The agenda below is the same month, the same day click
            into the same dialog, and it shows ALL of a day's tasks where the
            grid caps at three plus a "+n more" — so this is a layout choice,
            not a capability. `/calendar` keeps the grid. */}
        {!embedded && (
          <CalendarGrid
            calendarDays={calendarDays}
            tasksByDate={tasksByDate}
            weekdayShort={weekdayShort}
            onDayClick={openDayModal}
          />
        )}

        {/* Agenda list — phone layout on `/calendar`, the only layout of the
            surface's Takvim view.

            The visibility is spelled out both ways because `md:` reads the
            VIEWPORT: on `/calendar` the grid above takes over at md+ so the
            agenda hides, and EMBEDDED there is no grid, so it must stay
            visible at every width. `''` says that out loud. It used to say
            `undefined`, which CalendarAgenda's `?? 'md:hidden'` default read
            as "not stated" — so both branches hid the agenda and the Takvim
            column rendered the month nav above empty space at every desktop
            width. The prop is required now; there is no default left to fall
            into. */}
        <CalendarAgenda
          currentMonthDays={currentMonthDays}
          tasksByDate={tasksByDate}
          locale={locale}
          onDayClick={openDayModal}
          onSelectPerson={onSelectPerson}
          selectedLeadId={selectedLeadId}
          className={embedded ? '' : 'md:hidden'}
        />
      </QueryStateBoundary>

      {/* Day detail + create-task dialog */}
      <DayDialog
        open={selectedDate !== null}
        onOpenChange={(open) => { if (!open) setSelectedDate(null); }}
        selectedDate={selectedDate}
        dayTasks={selectedDayTasks}
        locale={locale}
        reps={reps}
        onCreateTask={(values: TaskFormValues) =>
          createMutation.mutate({
            title: values.title,
            type: values.type,
            priority: values.priority,
            // Combine local date + time into a full ISO datetime so the picked
            // hour is stored exactly (no off-by-one, no end-of-day default).
            dueDate: localDateTimeToIso(values.dueDate, values.dueTime),
            ...(values.description ? { description: values.description } : {}),
            ...(values.assignedToId ? { assignedToId: values.assignedToId } : {}),
          })
        }
        isPending={createMutation.isPending}
      />
    </div>
  );
}
