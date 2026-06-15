import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import platformApi from '../../../features/platform/api/platformApi';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import {
  EVENT_DRIVEN_KEYS,
  routineFormSchema,
  routineLabel,
  toUpdateBody,
  type RoutineConfig,
  type RoutineFormValues,
} from './routines';
import { extractMessage } from './routines';

interface RoutineConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  routine: RoutineConfig | null;
}

export function RoutineConfigDialog({ open, onOpenChange, routine }: RoutineConfigDialogProps) {
  const queryClient = useQueryClient();

  const form = useForm<RoutineFormValues>({
    resolver: zodResolver(routineFormSchema),
    mode: 'onBlur',
    defaultValues: {
      enabled: false,
      onEvent: false,
      cron: '',
      triggerUrl: '',
      triggerToken: '',
      eventCooldownSec: 300,
    },
  });

  // Seed the form from server data whenever a routine opens.
  useEffect(() => {
    if (open && routine) {
      form.reset({
        enabled: routine.enabled,
        onEvent: routine.onEvent,
        cron: routine.cron ?? '',
        triggerUrl: routine.triggerUrl ?? '',
        triggerToken: '',
        eventCooldownSec: routine.eventCooldownSec,
      });
    }
  }, [open, routine, form]);

  const saveMutation = useMutation({
    mutationFn: (values: RoutineFormValues) => {
      if (!routine) throw new Error('No routine');
      return platformApi.patch(`/routines/${routine.key}`, toUpdateBody(values)).then((r) => r.data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'routines'] });
      toast.success(`${routine ? routineLabel(routine.key) : 'Routine'} saved`);
      // Clear the write-only token field after a successful save.
      form.setValue('triggerToken', '');
      onOpenChange(false);
    },
    onError: (e: unknown) => toast.error(extractMessage(e)),
  });

  const onSubmit: SubmitHandler<RoutineFormValues> = (values) => saveMutation.mutate(values);

  const isEventDriven = routine ? EVENT_DRIVEN_KEYS.has(routine.key) : false;
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{routine ? routineLabel(routine.key) : 'Routine'}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{routine?.key}</span>
          </DialogDescription>
        </DialogHeader>

        {routine?.lastTriggerError && (
          <Callout tone="danger" title="Last trigger error">
            <span className="break-all font-mono text-xs">{routine.lastTriggerError}</span>
          </Callout>
        )}

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          {/* Toggles */}
          <div className="flex flex-wrap gap-6">
            <Controller
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Enabled" />
                  Enabled
                </label>
              )}
            />
            <Controller
              control={form.control}
              name="onEvent"
              render={({ field }) => (
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    aria-label="Trigger on event"
                  />
                  Trigger on event
                  {!isEventDriven && (
                    <span className="text-xs text-muted-foreground">(no events for this routine)</span>
                  )}
                </label>
              )}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Cron schedule"
              hint="Leave blank = no schedule (manual / event only)"
              error={errors.cron?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="0 3 * * *"
                  className="font-mono"
                  {...form.register('cron')}
                />
              )}
            </Field>

            <Field
              label="Event cooldown (seconds)"
              hint="Min seconds between event-driven triggers (debounce)"
              error={errors.eventCooldownSec?.message}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  {...form.register('eventCooldownSec')}
                />
              )}
            </Field>
          </div>

          <Field label="Trigger URL" error={errors.triggerUrl?.message}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="url"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="https://claude.ai/api/..."
                className="font-mono"
                {...form.register('triggerUrl')}
              />
            )}
          </Field>

          <Field
            label="Trigger token (write-only)"
            hint={
              routine?.hasToken
                ? 'A token is already stored. Leave blank to keep it unchanged.'
                : 'No token stored yet. Requires MARKETING_SECRET_KEY to be set on the server.'
            }
            error={errors.triggerToken?.message}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={
                  routine?.hasToken ? 'configured — paste to replace' : 'paste token from claude.ai'
                }
                {...form.register('triggerToken')}
              />
            )}
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" loading={saveMutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
