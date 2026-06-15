import { useEffect } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { taskSchema, type TaskFormValues } from '../../../features/marketing/schemas';
import type { MarketingTask } from '../../../features/marketing/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Button,
  Field,
  Input,
  Textarea,
  Badge,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  DatePicker,
} from '@/components/ui';
import { cn } from '@/components/ui/cn';

const typeLabels: Record<string, string> = {
  CALL: 'Call',
  VISIT: 'Visit',
  DEMO: 'Demo',
  FOLLOW_UP: 'Follow Up',
  MEETING: 'Meeting',
  OTHER: 'Other',
};

const statusTone: Record<string, 'warning' | 'info' | 'success' | 'neutral'> = {
  PENDING: 'warning',
  IN_PROGRESS: 'info',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
};

const priorityTone: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warning',
  URGENT: 'danger',
};

const TASK_TYPES = [
  { value: 'CALL', label: 'Call' },
  { value: 'VISIT', label: 'Visit' },
  { value: 'DEMO', label: 'Demo' },
  { value: 'FOLLOW_UP', label: 'Follow Up' },
  { value: 'MEETING', label: 'Meeting' },
  { value: 'OTHER', label: 'Other' },
] as const;

const PRIORITIES = [
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HIGH', label: 'High' },
  { value: 'URGENT', label: 'Urgent' },
] as const;

interface DayDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedDate: string | null;
  dayTasks: MarketingTask[];
  locale: string;
  onCreateTask: (values: TaskFormValues) => void;
  isPending: boolean;
}

export function DayDialog({
  open,
  onOpenChange,
  selectedDate,
  dayTasks,
  locale,
  onCreateTask,
  isPending,
}: DayDialogProps) {
  const { t } = useTranslation('marketing');

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    mode: 'onBlur',
    defaultValues: {
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: selectedDate ?? new Date().toISOString().split('T')[0],
    },
  });

  // Sync dueDate when the dialog opens for a new day
  useEffect(() => {
    if (open && selectedDate) {
      form.reset({
        title: '',
        description: '',
        type: 'FOLLOW_UP',
        priority: 'MEDIUM',
        dueDate: selectedDate,
      });
    }
  }, [open, selectedDate, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const errors = form.formState.errors;

  const handleSubmit: SubmitHandler<TaskFormValues> = (values) => {
    onCreateTask(values);
  };

  const displayDate = selectedDate
    ? new Date(selectedDate + 'T00:00:00').toLocaleDateString(locale, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{displayDate}</DialogTitle>
        </DialogHeader>

        {/* Existing tasks list */}
        {dayTasks.length > 0 ? (
          <div className="space-y-2 border-b border-border pb-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('tasks.title', { defaultValue: 'Tasks' })} ({dayTasks.length})
            </p>
            <div className="space-y-1.5">
              {dayTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center gap-2 p-2 rounded-lg bg-surface-muted"
                >
                  <div className="flex-1 min-w-0">
                    <p
                      className={cn(
                        'text-sm font-medium truncate',
                        task.status === 'COMPLETED'
                          ? 'line-through text-muted-foreground'
                          : 'text-foreground',
                      )}
                    >
                      {task.title}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">
                        {typeLabels[task.type] || task.type}
                      </span>
                      <Badge tone={priorityTone[task.priority] ?? 'neutral'} size="sm">
                        {t(`priority.${task.priority}`, { defaultValue: task.priority })}
                      </Badge>
                    </div>
                  </div>
                  <Badge tone={statusTone[task.status] ?? 'neutral'} size="sm">
                    {task.status === 'IN_PROGRESS'
                      ? 'In Progress'
                      : task.status.charAt(0) + task.status.slice(1).toLowerCase()}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<Plus className="h-8 w-8" />}
            title={t('calendar.noTasks', { defaultValue: 'No tasks this day' })}
            description={t('calendar.createFirst', { defaultValue: 'Create one below.' })}
            className="border-0 py-4"
          />
        )}

        {/* Create task form */}
        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-primary" aria-hidden="true" />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('tasks.createButton', { defaultValue: 'Create Task' })}
            </p>
          </div>

          <Field
            label={t('leadDetail.taskDialog.titleLabel', { defaultValue: 'Title' })}
            error={fieldErr(errors.title?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('leadDetail.taskDialog.titleLabel', { defaultValue: 'Task title' })}
                autoFocus
                {...form.register('title')}
              />
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t('leadDetail.taskDialog.typeLabel', { defaultValue: 'Type' })}
              error={fieldErr(errors.type?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="type"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TASK_TYPES.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {t(`taskType.${opt.value}`, { defaultValue: opt.label })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>

            <Field
              label={t('leadDetail.taskDialog.priorityLabel', { defaultValue: 'Priority' })}
              error={fieldErr(errors.priority?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="priority"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PRIORITIES.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {t(`priority.${opt.value}`, { defaultValue: opt.label })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
          </div>

          <Field
            label={t('leadDetail.taskDialog.dueDateLabel', { defaultValue: 'Due Date' })}
            error={fieldErr(errors.dueDate?.message)}
            required
          >
            {() => (
              <Controller
                control={form.control}
                name="dueDate"
                render={({ field }) => (
                  <DatePicker
                    aria-label={t('leadDetail.taskDialog.dueDateLabel', { defaultValue: 'Due Date' })}
                    value={field.value ? new Date(field.value + 'T12:00:00') : null}
                    onChange={(date) => field.onChange(date.toISOString().split('T')[0])}
                  />
                )}
              />
            )}
          </Field>

          <Field
            label={t('leadDetail.taskDialog.descriptionLabel', { defaultValue: 'Description (optional)' })}
            error={fieldErr(errors.description?.message)}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('leadDetail.taskDialog.descriptionLabel', { defaultValue: 'Add details...' })}
                rows={2}
                {...form.register('description')}
              />
            )}
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {t('tasks.createButton', { defaultValue: 'Create Task' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
