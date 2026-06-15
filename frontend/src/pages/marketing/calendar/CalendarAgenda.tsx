import type { MarketingTask } from '../../../features/marketing/types';
import { cn } from '@/components/ui/cn';

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
}

/** Mobile-only agenda list — hidden md+ (CalendarGrid takes over). */
export function CalendarAgenda({
  currentMonthDays,
  tasksByDate,
  locale,
  onDayClick,
}: CalendarAgendaProps) {
  return (
    <div className="md:hidden rounded-xl border border-border bg-surface overflow-hidden divide-y divide-border">
      {currentMonthDays.map(({ date }) => {
        const dateKey = toLocalDateKey(date);
        const dayTasks = tasksByDate[dateKey] || [];
        const today = isToday(date);

        return (
          <button
            key={dateKey}
            type="button"
            onClick={() => onDayClick(dateKey)}
            className="w-full text-left flex items-start gap-3 p-3 hover:bg-surface-muted transition-colors"
          >
            <div
              className={cn(
                'shrink-0 w-10 text-center',
                today ? 'text-primary' : 'text-foreground',
              )}
            >
              <div className="text-[10px] uppercase text-muted-foreground">
                {date.toLocaleString(locale, { weekday: 'short' })}
              </div>
              <div className="text-lg font-semibold">{date.getDate()}</div>
            </div>
            <div className="flex-1 min-w-0 py-0.5">
              {dayTasks.length === 0 ? (
                <p className="text-xs text-muted-foreground pt-2">—</p>
              ) : (
                <div className="space-y-1">
                  {dayTasks.map((task) => (
                    <div
                      key={task.id}
                      className={cn(
                        'text-xs px-2 py-1 rounded truncate',
                        task.status === 'COMPLETED'
                          ? 'bg-success-subtle text-success line-through'
                          : 'bg-primary/15 text-primary',
                      )}
                    >
                      {task.title}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
