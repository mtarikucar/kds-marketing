import { useEffect, useState } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Phone } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { ActivityTimeline } from '../../../features/marketing/components';
import { ActivityType } from '../../../features/marketing/types';
import type { LeadActivity } from '../../../features/marketing/types';

const activitySchema = z.object({
  type: z.string().min(1, 'required'),
  title: z.string().trim().min(1, 'required').max(200),
  description: z.string().trim().max(2000).optional(),
});

type ActivityFormValues = z.infer<typeof activitySchema>;

interface ActivityTimelineTabProps {
  /** The lead this tab is showing — used to reset the draft on lead change. */
  leadId: string;
  activities: LeadActivity[];
  onSubmit: (data: { type: string; title: string; description?: string }) => void;
  isPending: boolean;
}

export default function ActivityTimelineTab({
  leadId,
  activities,
  onSubmit,
  isPending,
}: ActivityTimelineTabProps) {
  const [open, setOpen] = useState(false);

  const form = useForm<ActivityFormValues>({
    resolver: zodResolver(activitySchema),
    mode: 'onBlur',
    defaultValues: { type: 'NOTE', title: '', description: '' },
  });

  // The lead-detail route reuses this tab across /leads/:id navigations (no
  // remount, like WalletPanel) — clear + close a half-typed activity draft when
  // the lead changes so it can't be logged against the next contact.
  useEffect(() => {
    form.reset({ type: 'NOTE', title: '', description: '' });
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // Open the activity dialog pre-set to a given type (first-class "Log call").
  const openWith = (type: string) => {
    form.reset({ type, title: '', description: '' });
    setOpen(true);
  };

  const submit: SubmitHandler<ActivityFormValues> = (values) => {
    onSubmit({
      type: values.type,
      title: values.title,
      description: values.description || undefined,
    });
    form.reset({ type: values.type, title: '', description: '' });
    setOpen(false);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Activity Timeline</CardTitle>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openWith('CALL')}
            className="text-primary hover:text-primary"
          >
            <Phone className="h-4 w-4" /> Log call
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openWith('NOTE')}
            className="text-primary hover:text-primary"
          >
            <Plus className="h-4 w-4" /> Add Activity
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ActivityTimeline activities={activities || []} />
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Activity</DialogTitle>
            <DialogDescription>Log a new activity on this lead.</DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-4">
            <Controller
              control={form.control}
              name="type"
              render={({ field, fieldState }) => (
                <Field label="Type" error={fieldState.error?.message}>
                  {() => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(ActivityType).map((tp) => (
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
            <Field label="Title" required error={form.formState.errors.title?.message}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="Activity title"
                  {...form.register('title')}
                />
              )}
            </Field>
            <Field label="Description" error={form.formState.errors.description?.message}>
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
              <Button type="submit" loading={isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
