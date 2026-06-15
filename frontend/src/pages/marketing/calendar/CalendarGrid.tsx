import type { MarketingTask } from '../../../features/marketing/types';
import { Badge } from '@/components/ui';
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

interface CalendarGridProps {
  calendarDays: { date: Date; isCurrentMonth: boolean }[];
  tasksByDate: Record<string, MarketingTask[]>;
  weekdayShort: string[];
  onDayClick: (dateKey: string) => void;
}

export function CalendarGrid({
  calendarDays,
  tasksByDate,
  weekdayShort,
  onDayClick,
}: CalendarGridProps) {
  return (
    <div className="hidden md:block rounded-xl border border-border bg-surface overflow-hidden">
      {/* Day headers */}
      <div className="grid grid-cols-7 border-b border-border">
        {weekdayShort.map((day) => (
          <div
            key={day}
            className="px-2 py-2 text-center text-xs font-medium text-muted-foreground"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {calendarDays.map(({ date, isCurrentMonth }, idx) => {
          const dateKey = toLocalDateKey(date);
          const dayTasks = tasksByDate[dateKey] || [];
          const taskCount = dayTasks.length;
          const today = isToday(date);

          return (
            <div
              key={idx}
              onClick={() => onDayClick(dateKey)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onDayClick(dateKey)}
              aria-label={`${date.toDateString()}, ${taskCount} task${taskCount !== 1 ? 's' : ''}`}
              className={cn(
                'min-h-[80px] p-1 border-b border-r border-border cursor-pointer transition-colors hover:bg-primary/5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                !isCurrentMonth && 'bg-surface-muted',
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <p
                  className={cn(
                    'text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full',
                    today
                      ? 'bg-primary text-primary-foreground'
                      : isCurrentMonth
                        ? 'text-foreground'
                        : 'text-muted-foreground',
                  )}
                >
                  {date.getDate()}
                </p>
                {taskCount > 0 && (
                  <Badge tone="primary" size="sm" className="min-w-[18px] justify-center px-1">
                    {taskCount}
                  </Badge>
                )}
              </div>
              <div className="space-y-0.5">
                {dayTasks.slice(0, 3).map((task) => (
                  <div
                    key={task.id}
                    title={task.title}
                    className={cn(
                      'text-xs px-1 py-0.5 rounded truncate',
                      task.status === 'COMPLETED'
                        ? 'bg-success-subtle text-success line-through'
                        : 'bg-primary/15 text-primary',
                    )}
                  >
                    {task.title}
                  </div>
                ))}
                {dayTasks.length > 3 && (
                  <p className="text-xs text-muted-foreground px-1">
                    +{dayTasks.length - 3} more
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
