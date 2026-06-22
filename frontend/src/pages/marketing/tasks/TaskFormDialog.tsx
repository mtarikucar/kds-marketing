import { useEffect } from 'react';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { toLocalYmd, toLocalHm } from '../../../features/marketing/utils/datetime';
import type { MarketingUserInfo } from '../../../features/marketing/types';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { taskSchema, type TaskFormValues } from '../../../features/marketing/schemas';
import type { MarketingTask } from '../../../features/marketing/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { DatePicker } from '@/components/ui/DatePicker';

interface RepRow extends MarketingUserInfo {
  role: string;
}

interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a task to edit, or undefined/null to create. */
  task?: MarketingTask | null;
  onSubmit: (values: TaskFormValues) => void;
  isPending: boolean;
  /** Workspace marketing users for the assignee picker (managers only). */
  reps?: RepRow[];
}

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

// Sensible default hour for a new task when none is picked.
const DEFAULT_DUE_TIME = '09:00';

export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  onSubmit,
  isPending,
  reps = [],
}: TaskFormDialogProps) {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const isEdit = !!task;
  const currentUserId = user?.id;

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    mode: 'onBlur',
    defaultValues: {
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: toLocalYmd(new Date()),
      dueTime: DEFAULT_DUE_TIME,
      assignedToId: currentUserId,
    },
  });

  // Populate form when editing
  useEffect(() => {
    if (open) {
      if (task) {
        const due = task.dueDate ? new Date(task.dueDate) : null;
        form.reset({
          title: task.title,
          description: task.description || '',
          type: task.type as TaskFormValues['type'],
          priority: task.priority as TaskFormValues['priority'],
          dueDate: due ? toLocalYmd(due) : toLocalYmd(new Date()),
          dueTime: due ? toLocalHm(due) : DEFAULT_DUE_TIME,
          assignedToId: task.assignedTo?.id || currentUserId,
        });
      } else {
        form.reset({
          title: '',
          description: '',
          type: 'FOLLOW_UP',
          priority: 'MEDIUM',
          dueDate: toLocalYmd(new Date()),
          dueTime: DEFAULT_DUE_TIME,
          assignedToId: currentUserId,
        });
      }
    }
  }, [task, open, form, currentUserId]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<TaskFormValues> = (values) => {
    onSubmit(values);
  };

  // Quick presets: set date+time in one click, all in local wall-clock so the
  // saved value matches what the label says.
  const applyPreset = (preset: 'today6pm' | 'tomorrow9am' | 'nextWeek') => {
    const now = new Date();
    let target: Date;
    let time: string;
    if (preset === 'today6pm') {
      target = now;
      time = '18:00';
    } else if (preset === 'tomorrow9am') {
      target = new Date(now);
      target.setDate(target.getDate() + 1);
      time = '09:00';
    } else {
      target = new Date(now);
      target.setDate(target.getDate() + 7);
      time = '09:00';
    }
    form.setValue('dueDate', toLocalYmd(target), { shouldValidate: true });
    form.setValue('dueTime', time, { shouldValidate: true });
  };

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('common.edit') + ' ' + t('nav.tasks') : t('tasks.createButton')}
          </DialogTitle>
          <DialogDescription>
            {isEdit ? t('tasks.subtitle') : t('tasks.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          {/* Title */}
          <Field
            label={t('leadDetail.taskDialog.titleLabel')}
            error={fieldErr(errors.title?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('leadDetail.taskDialog.titleLabel')}
                {...form.register('title')}
              />
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            {/* Type */}
            <Field
              label={t('leadDetail.taskDialog.typeLabel')}
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

            {/* Priority */}
            <Field
              label={t('leadDetail.taskDialog.priorityLabel')}
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

          {/* Due date + time */}
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field
                label={t('leadDetail.taskDialog.dueDateLabel')}
                error={fieldErr(errors.dueDate?.message)}
                required
              >
                {() => (
                  <Controller
                    control={form.control}
                    name="dueDate"
                    render={({ field }) => (
                      <DatePicker
                        aria-label={t('leadDetail.taskDialog.dueDateLabel')}
                        value={field.value ? new Date(field.value + 'T12:00:00') : null}
                        onChange={(date) => field.onChange(toLocalYmd(date))}
                      />
                    )}
                  />
                )}
              </Field>

              <Field
                label={t('leadDetail.taskDialog.timeLabel', { defaultValue: 'Time' })}
                error={fieldErr(errors.dueTime?.message)}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="time"
                    className="w-32"
                    {...form.register('dueTime')}
                  />
                )}
              </Field>
            </div>

            {/* Quick presets */}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset('today6pm')}>
                {t('tasks.presets.today6pm', { defaultValue: 'Today 6:00 PM' })}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset('tomorrow9am')}>
                {t('tasks.presets.tomorrow9am', { defaultValue: 'Tomorrow 9:00 AM' })}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => applyPreset('nextWeek')}>
                {t('tasks.presets.nextWeek', { defaultValue: '+1 week' })}
              </Button>
            </div>
          </div>

          {/* Assignee — only when reps are available (managers); reps create for self */}
          {reps.length > 0 && (
            <Field
              label={t('leadDetail.taskDialog.assigneeLabel', { defaultValue: 'Assignee' })}
              error={fieldErr(errors.assignedToId?.message)}
            >
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="assignedToId"
                  render={({ field }) => (
                    <Select value={field.value || ''} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {reps.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.firstName} {r.lastName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
          )}

          {/* Description */}
          <Field
            label={t('leadDetail.taskDialog.descriptionLabel')}
            error={fieldErr(errors.description?.message)}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('leadDetail.taskDialog.descriptionLabel')}
                rows={3}
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
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit ? t('common.save') : t('tasks.createButton')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
