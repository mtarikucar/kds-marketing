import type { MarketingTask } from '../../../features/marketing/types';
import { cn } from '@/components/ui/cn';

/** The person a task belongs to, as much of them as `/tasks/calendar` returns. */
type TaskLead = NonNullable<MarketingTask['lead']>;

function toLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isToday(date: Date): boolean {
  const today = new Date();
  return date.toDateString() === today.toDateString();
}

interface CalendarAgendaProps {
  /** Only current-month days */
  currentMonthDays: { date: Date }[];
  tasksByDate: Record<string, MarketingTask[]>;
  locale: string;
  onDayClick: (dateKey: string) => void;
  /**
   * Report the person a task belongs to. Given, each task with a lead becomes
   * its own control INSIDE the day row rather than part of it — a button in a
   * button is not valid HTML and screen readers flatten it — so the day header
   * and the tasks are siblings when this is present.
   */
  onSelectPerson?: (person: TaskLead) => void;
  /** Who the host has open, so the agenda can mark their tasks. */
  selectedLeadId?: string | null;
  /**
   * Replaces the default `md:hidden`. The agenda is the phone layout of
   * `/calendar`, but it is also the ONLY layout of the surface's Takvim view:
   * Tailwind v3 has no container queries, so `md:` reads the viewport and the
   * seven-column grid would render at ~85px a cell inside a 40% column. The
   * host passes a visibility of its own rather than this file guessing at one.
   */
  className?: string;
}

/** Agenda list — one row per day of the month. Hidden md+ by default, where
 *  CalendarGrid takes over; see `className`. */
export function CalendarAgenda({
  currentMonthDays,
  tasksByDate,
  locale,
  onDayClick,
  onSelectPerson,
  selectedLeadId,
  className,
}: CalendarAgendaProps) {
  return (
    <div
      data-testid="calendar-agenda"
      className={cn(
        'rounded-xl border border-border bg-surface overflow-hidden divide-y divide-border',
        className ?? 'md:hidden',
      )}
    >
      {currentMonthDays.map(({ date }) => {
        const dateKey = toLocalDateKey(date);
        const dayTasks = tasksByDate[dateKey] || [];
        const today = isToday(date);

        const chip = (task: MarketingTask) =>
          cn(
            'w-full text-left text-xs px-2 py-1 rounded truncate',
            task.status === 'COMPLETED'
              ? 'bg-success-subtle text-success line-through'
              : 'bg-primary/15 text-primary',
          );

        return (
          <div key={dateKey} className="flex items-start gap-3 p-3">
            {/* The day itself — opens the dialog that lists and creates. */}
            <button
              type="button"
              onClick={() => onDayClick(dateKey)}
              aria-label={`${date.toDateString()}, ${dayTasks.length} task${dayTasks.length !== 1 ? 's' : ''}`}
              className={cn(
                'shrink-0 w-10 text-center rounded hover:bg-surface-muted transition-colors',
                today ? 'text-primary' : 'text-foreground',
              )}
            >
              <div className="text-[10px] uppercase text-muted-foreground">
                {date.toLocaleString(locale, { weekday: 'short' })}
              </div>
              <div className="text-lg font-semibold">{date.getDate()}</div>
            </button>
            <div className="flex-1 min-w-0 py-0.5">
              {dayTasks.length === 0 ? (
                <button
                  type="button"
                  onClick={() => onDayClick(dateKey)}
                  className="w-full text-left text-xs text-muted-foreground pt-2 hover:text-foreground"
                >
                  —
                </button>
              ) : (
                <div className="space-y-1">
                  {dayTasks.map((task) =>
                    // A task naming a person SELECTS them; one naming nobody has
                    // nobody to select, so it stays the label it was rather than
                    // becoming a control that does nothing.
                    onSelectPerson && task.lead ? (
                      <button
                        key={task.id}
                        type="button"
                        data-testid={`calendar-task-${task.id}`}
                        aria-current={!!selectedLeadId && task.lead.id === selectedLeadId}
                        onClick={() => onSelectPerson(task.lead!)}
                        className={cn(chip(task), 'aria-[current=true]:ring-1 ring-primary')}
                      >
                        {task.title}
                      </button>
                    ) : (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => onDayClick(dateKey)}
                        className={chip(task)}
                      >
                        {task.title}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
