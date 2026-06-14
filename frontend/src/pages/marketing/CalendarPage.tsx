import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon, PlusIcon } from '@heroicons/react/24/outline';
import marketingApi from '../../features/marketing/api/marketingApi';
import { PageHeader } from '../../features/marketing/components';
import type { MarketingTask } from '../../features/marketing/types';

function toLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const typeLabels: Record<string, string> = {
  CALL: 'Call',
  VISIT: 'Visit',
  DEMO: 'Demo',
  FOLLOW_UP: 'Follow Up',
  MEETING: 'Meeting',
  OTHER: 'Other',
};

const statusColors: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-700',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
  COMPLETED: 'bg-green-100 text-green-700',
  CANCELLED: 'bg-gray-100 text-gray-500',
};

const priorityBadgeColors: Record<string, string> = {
  LOW: 'text-gray-500',
  MEDIUM: 'text-blue-600',
  HIGH: 'text-orange-600',
  URGENT: 'text-red-600',
};

const emptyForm = {
  title: '',
  type: 'FOLLOW_UP',
  priority: 'MEDIUM',
  dueDate: '',
  description: '',
};

export default function CalendarPage() {
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation('marketing');
  const locale = i18n.language || 'tr';
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // Send LOCAL date-only bounds (YYYY-MM-DD), not UTC instants. The grid
  // buckets tasks by `toLocalDateKey`, so the fetch window has to be the same
  // local calendar month — using `.toISOString()` here shifted the bounds by
  // the timezone offset and could drop the first/last day's tasks for users
  // east/west of UTC.
  const dateFrom = toLocalDateKey(new Date(year, month, 1));
  const dateTo = toLocalDateKey(new Date(year, month + 1, 0));

  const { data: tasks } = useQuery({
    queryKey: ['marketing', 'tasks', 'calendar', year, month],
    queryFn: () =>
      marketingApi
        .get('/tasks/calendar', { params: { dateFrom, dateTo } })
        .then((r) => r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: typeof form) => marketingApi.post('/tasks', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'tasks'] });
      setForm({ ...emptyForm, dueDate: selectedDate || '' });
      toast.success('Task created');
    },
    onError: () => {
      toast.error('Failed to create task');
    },
  });

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

  const isToday = (date: Date) => {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  };

  const openDayModal = (dateKey: string) => {
    setSelectedDate(dateKey);
    setForm({ ...emptyForm, dueDate: dateKey });
  };

  const closeModal = () => {
    setSelectedDate(null);
    setForm({ ...emptyForm });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    createMutation.mutate(form);
  };

  const selectedDayTasks = selectedDate ? (tasksByDate[selectedDate] || []) : [];

  const monthName = currentDate.toLocaleString(locale, { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-4">
      <PageHeader title={t('calendar.title')} subtitle={t('calendar.subtitle')} />

      {/* Navigation */}
      <div className="flex items-center justify-between bg-white rounded-xl border border-gray-200 p-4">
        <button onClick={() => goToMonth(-1)} className="p-2 hover:bg-gray-100 rounded-lg">
          <ChevronLeftIcon className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-gray-900">{monthName}</h2>
        <button onClick={() => goToMonth(1)} className="p-2 hover:bg-gray-100 rounded-lg">
          <ChevronRightIcon className="w-5 h-5" />
        </button>
      </div>

      {/* Calendar Grid — desktop/tablet (md+); phones get the agenda list below */}
      <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Day headers */}
        <div className="grid grid-cols-7 border-b">
          {(t('calendar.weekdayShort', { returnObjects: true }) as string[]).map((day) => (
            <div key={day} className="px-2 py-2 text-center text-xs font-medium text-gray-500">
              {day}
            </div>
          ))}
        </div>

        {/* Days */}
        <div className="grid grid-cols-7">
          {calendarDays.map(({ date, isCurrentMonth }, idx) => {
            const dateKey = toLocalDateKey(date);
            const dayTasks = tasksByDate[dateKey] || [];
            const taskCount = dayTasks.length;

            return (
              <div
                key={idx}
                onClick={() => openDayModal(dateKey)}
                className={`min-h-[80px] p-1 border-b border-r cursor-pointer transition-colors hover:bg-primary/5 ${
                  !isCurrentMonth ? 'bg-gray-50' : ''
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <p
                    className={`text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full ${
                      isToday(date) ? 'bg-primary text-white' : isCurrentMonth ? 'text-gray-900' : 'text-gray-400'
                    }`}
                  >
                    {date.getDate()}
                  </p>
                  {taskCount > 0 && (
                    <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-primary text-white text-[10px] font-semibold px-1">
                      {taskCount}
                    </span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {dayTasks.slice(0, 3).map((task) => (
                    <div
                      key={task.id}
                      className={`text-xs px-1 py-0.5 rounded truncate ${
                        task.status === 'COMPLETED'
                          ? 'bg-green-100 text-green-700 line-through'
                          : 'bg-primary/15 text-primary'
                      }`}
                      title={task.title}
                    >
                      {task.title}
                    </div>
                  ))}
                  {dayTasks.length > 3 && (
                    <p className="text-xs text-gray-400 px-1">+{dayTasks.length - 3} more</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Mobile agenda — phones get a tappable day list instead of the 7-col grid */}
      <div className="md:hidden bg-white rounded-xl border border-gray-200 overflow-hidden divide-y">
        {calendarDays
          .filter((d) => d.isCurrentMonth)
          .map(({ date }) => {
            const dateKey = toLocalDateKey(date);
            const dayTasks = tasksByDate[dateKey] || [];
            return (
              <button
                key={dateKey}
                onClick={() => openDayModal(dateKey)}
                className="w-full text-left flex items-start gap-3 p-3 hover:bg-gray-50"
              >
                <div className={`shrink-0 w-10 text-center ${isToday(date) ? 'text-primary' : 'text-gray-700'}`}>
                  <div className="text-[10px] uppercase">{date.toLocaleString(locale, { weekday: 'short' })}</div>
                  <div className="text-lg font-semibold">{date.getDate()}</div>
                </div>
                <div className="flex-1 min-w-0 py-0.5">
                  {dayTasks.length === 0 ? (
                    <p className="text-xs text-gray-300 pt-2">—</p>
                  ) : (
                    <div className="space-y-1">
                      {dayTasks.map((task) => (
                        <div
                          key={task.id}
                          className={`text-xs px-2 py-1 rounded truncate ${
                            task.status === 'COMPLETED'
                              ? 'bg-green-100 text-green-700 line-through'
                              : 'bg-primary/15 text-primary'
                          }`}
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

      {/* Day detail modal */}
      {selectedDate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={closeModal}>
          <div
            className="bg-white rounded-xl border border-gray-200 shadow-xl w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between p-4 border-b">
              <h3 className="text-base font-semibold text-gray-900">
                {new Date(selectedDate + 'T00:00:00').toLocaleDateString(locale, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </h3>
              <button onClick={closeModal} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600">
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>

            {/* Existing tasks list */}
            {selectedDayTasks.length > 0 && (
              <div className="p-4 border-b space-y-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  Tasks ({selectedDayTasks.length})
                </p>
                <div className="space-y-1.5">
                  {selectedDayTasks.map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center gap-2 p-2 rounded-lg bg-gray-50"
                    >
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${task.status === 'COMPLETED' ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                          {task.title}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-gray-500">{typeLabels[task.type] || task.type}</span>
                          <span className={`text-xs font-medium ${priorityBadgeColors[task.priority] || ''}`}>
                            {task.priority}
                          </span>
                        </div>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${statusColors[task.status] || 'bg-gray-100 text-gray-600'}`}>
                        {task.status === 'IN_PROGRESS' ? 'In Progress' : task.status.charAt(0) + task.status.slice(1).toLowerCase()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Create task form */}
            <form onSubmit={handleSubmit} className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <PlusIcon className="w-4 h-4 text-primary" />
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Create Task</p>
              </div>

              <input
                type="text"
                placeholder="Task title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                autoFocus
              />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Type</label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                  >
                    <option value="CALL">Call</option>
                    <option value="VISIT">Visit</option>
                    <option value="DEMO">Demo</option>
                    <option value="FOLLOW_UP">Follow Up</option>
                    <option value="MEETING">Meeting</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Priority</label>
                  <select
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                    <option value="URGENT">Urgent</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Due Date</label>
                <input
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Description (optional)</label>
                <textarea
                  placeholder="Add details..."
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none resize-none"
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={!form.title.trim() || createMutation.isPending}
                  className="flex-1 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {createMutation.isPending ? 'Creating...' : 'Create Task'}
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
