import { useEffect } from 'react';
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

interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a task to edit, or undefined/null to create. */
  task?: MarketingTask | null;
  onSubmit: (values: TaskFormValues) => void;
  isPending: boolean;
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

export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  onSubmit,
  isPending,
}: TaskFormDialogProps) {
  const { t } = useTranslation('marketing');
  const isEdit = !!task;

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    mode: 'onBlur',
    defaultValues: {
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: new Date().toISOString().split('T')[0],
    },
  });

  // Populate form when editing
  useEffect(() => {
    if (open) {
      if (task) {
        form.reset({
          title: task.title,
          description: task.description || '',
          type: task.type as TaskFormValues['type'],
          priority: task.priority as TaskFormValues['priority'],
          dueDate: task.dueDate ? task.dueDate.split('T')[0] : new Date().toISOString().split('T')[0],
        });
      } else {
        form.reset({
          title: '',
          description: '',
          type: 'FOLLOW_UP',
          priority: 'MEDIUM',
          dueDate: new Date().toISOString().split('T')[0],
        });
      }
    }
  }, [task, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<TaskFormValues> = (values) => {
    onSubmit(values);
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

          {/* Due Date */}
          <Field
            label={t('leadDetail.taskDialog.dueDateLabel')}
            error={fieldErr(errors.dueDate?.message)}
            required
          >
            {({ id: _id }) => (
              <Controller
                control={form.control}
                name="dueDate"
                render={({ field }) => (
                  <DatePicker
                    aria-label={t('leadDetail.taskDialog.dueDateLabel')}
                    value={field.value ? new Date(field.value + 'T12:00:00') : null}
                    onChange={(date) => field.onChange(date.toISOString().split('T')[0])}
                  />
                )}
              />
            )}
          </Field>

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
