import { useState } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { Plus, CheckCircle2, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/components/ui/cn';
import { taskSchema, type TaskFormValues } from '../../../features/marketing/schemas';
import { TaskType } from '../../../features/marketing/types';
import type { MarketingTask } from '../../../features/marketing/types';
import { localDateTimeToIso, toLocalYmd } from '../../../features/marketing/utils/datetime';

const taskPriorityColor: Record<string, string> = {
  LOW: 'text-muted-foreground',
  MEDIUM: 'text-info',
  HIGH: 'text-warning',
  URGENT: 'text-danger',
};

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

interface TasksTabProps {
  leadId: string;
  tasks: MarketingTask[];
  fmtDate: (d: string | Date | null | undefined) => string;
  onCreate: (data: Record<string, unknown>) => void;
  createPending: boolean;
  onComplete: (taskId: string) => void;
  onDelete: (taskId: string) => void;
}

export default function TasksTab({
  leadId,
  tasks,
  fmtDate,
  onCreate,
  createPending,
  onComplete,
  onDelete,
}: TasksTabProps) {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    mode: 'onBlur',
    defaultValues: {
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: toLocalYmd(new Date()),
      dueTime: '09:00',
      leadId,
    },
  });

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const submit: SubmitHandler<TaskFormValues> = (values) => {
    onCreate({
      title: values.title,
      type: values.type,
      priority: values.priority,
      dueDate: localDateTimeToIso(values.dueDate, values.dueTime),
      leadId,
      ...(values.description ? { description: values.description } : {}),
    });
    form.reset({
      title: '',
      description: '',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      dueDate: toLocalYmd(new Date()),
      dueTime: '09:00',
      leadId,
    });
    setOpen(false);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Tasks</CardTitle>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          className="text-primary hover:text-primary"
        >
          <Plus className="h-4 w-4" /> New Task
        </Button>
      </CardHeader>
      <CardContent>
        {(tasks || []).length === 0 ? (
          <EmptyState title="No tasks yet" />
        ) : (
          <div className="space-y-2">
            {(tasks || []).map((task) => {
              const done = task.status === 'COMPLETED';
              return (
                <div
                  key={task.id}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <button
                    type="button"
                    onClick={() => !done && onComplete(task.id)}
                    disabled={done}
                    aria-label={done ? 'Completed' : 'Mark complete'}
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                      done
                        ? 'border-success bg-success'
                        : 'border-border-strong hover:border-success',
                    )}
                  >
                    {done && <CheckCircle2 className="h-4 w-4 text-success-foreground" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'text-sm font-medium',
                        done ? 'text-muted-foreground line-through' : 'text-foreground',
                      )}
                    >
                      {task.title}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded bg-surface-muted px-1.5 py-0.5">{task.type}</span>
                      <span className={taskPriorityColor[task.priority] || ''}>{task.priority}</span>
                      <span>Due: {fmtDate(task.dueDate)}</span>
                    </div>
                  </div>
                  {!done && (
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label="Delete task"
                      className="text-muted-foreground hover:text-danger"
                      onClick={() => {
                        if (window.confirm('Delete this task?')) onDelete(task.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Task</DialogTitle>
            <DialogDescription>Create a follow-up task for this lead.</DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-4">
            <Field label="Title" required error={fieldErr(form.formState.errors.title?.message)}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="Task title"
                  {...form.register('title')}
                />
              )}
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="type"
                render={({ field, fieldState }) => (
                  <Field label="Type" error={fieldErr(fieldState.error?.message)}>
                    {() => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.values(TaskType).map((tp) => (
                            <SelectItem key={tp} value={tp}>
                              {tp}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="priority"
                render={({ field, fieldState }) => (
                  <Field label="Priority" error={fieldErr(fieldState.error?.message)}>
                    {() => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PRIORITIES.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p.charAt(0) + p.slice(1).toLowerCase()}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                )}
              />
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field label="Due Date" required error={fieldErr(form.formState.errors.dueDate?.message)}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="date"
                    {...form.register('dueDate')}
                  />
                )}
              </Field>
              <Field label="Time" error={fieldErr(form.formState.errors.dueTime?.message)}>
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
            <Field label="Description" error={fieldErr(form.formState.errors.description?.message)}>
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  rows={2}
                  placeholder="Description (optional)"
                  {...form.register('description')}
                />
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={createPending}>
                Create Task
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
