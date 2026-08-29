import { useEffect, useState } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Phone } from 'lucide-react';
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
import { ActivityType } from '../../../features/marketing/types';

const activitySchema = z.object({
  type: z.string().min(1, 'required'),
  title: z.string().trim().min(1, 'required').max(200),
  description: z.string().trim().max(2000).optional(),
});

type ActivityFormValues = z.infer<typeof activitySchema>;

interface LogActivityDialogProps {
  /** The lead this is logging against — used to reset the draft on lead change. */
  leadId: string;
  onSubmit: (data: { type: string; title: string; description?: string }) => void;
  isPending: boolean;
}

/**
 * The two triggers that WRITE a lead activity, and the dialog behind them.
 *
 * Lifted out of `ActivityTimelineTab` when the lead detail collapsed from five
 * tabs to four. That component was two things stapled together: a rendering of
 * `lead.activities` and the form that creates one. `LeadStream` took over the
 * rendering — activities and messages on one axis, from one endpoint — but a
 * rep still has to be able to record the call they just made from their own
 * handset, so the writing half survives on its own.
 *
 * Deliberately NOT folded into `LeadStream`. That component is mounted by two
 * different surfaces and takes its composer as a SLOT; baking a lead-activity
 * form into it would hand the three-column surface a second, conflicting
 * composer next to the message one it owns.
 */
export default function LogActivityDialog({
  leadId,
  onSubmit,
  isPending,
}: LogActivityDialogProps) {
  const [open, setOpen] = useState(false);

  const form = useForm<ActivityFormValues>({
    resolver: zodResolver(activitySchema),
    mode: 'onBlur',
    defaultValues: { type: 'NOTE', title: '', description: '' },
  });

  // The lead-detail route reuses this across /leads/:id navigations (no
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
    <>
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
    </>
  );
}
