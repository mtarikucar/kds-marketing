import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import type { MarketingTask } from '../../../features/marketing/types';
import type { TaskFormValues } from '../../../features/marketing/schemas';
import {
  PageHeader,
  Card,
  CardContent,
  Button,
  IconButton,
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

export default function CalendarPage() {
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation('marketing');
  const locale = i18n.language || 'tr';

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

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['marketing', 'tasks', 'calendar', year, month],
    queryFn: () =>
      marketingApi
        .get('/tasks/calendar', { params: { dateFrom, dateTo } })
        .then((r) => r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: TaskFormValues) => marketingApi.post('/tasks', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'tasks'] });
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
      <PageHeader
        title={t('calendar.title')}
        description={t('calendar.subtitle')}
      />

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

      {/* Loading skeleton */}
      {isLoading && (
        <div className="rounded-xl border border-border bg-surface p-4 grid grid-cols-7 gap-1">
          {Array.from({ length: 35 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      )}

      {/* Desktop month grid */}
      {!isLoading && (
        <CalendarGrid
          calendarDays={calendarDays}
          tasksByDate={tasksByDate}
          weekdayShort={weekdayShort}
          onDayClick={openDayModal}
        />
      )}

      {/* Mobile agenda list */}
      {!isLoading && (
        <CalendarAgenda
          currentMonthDays={currentMonthDays}
          tasksByDate={tasksByDate}
          locale={locale}
          onDayClick={openDayModal}
        />
      )}

      {/* Day detail + create-task dialog */}
      <DayDialog
        open={selectedDate !== null}
        onOpenChange={(open) => { if (!open) setSelectedDate(null); }}
        selectedDate={selectedDate}
        dayTasks={selectedDayTasks}
        locale={locale}
        onCreateTask={(values) => createMutation.mutate(values)}
        isPending={createMutation.isPending}
      />
    </div>
  );
}
