import { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
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
import { Checkbox } from '@/components/ui/Checkbox';
import { Label } from '@/components/ui/Label';
import { WEBHOOK_EVENTS } from './webhookEvents';

// ── Schema ───────────────────────────────────────────────────────────────────
// Mirrors the backend Create/Update webhook DTO: url (≤2000) + optional events
// + optional description (≤200). An empty events array means "all events".

export const webhookSchema = z.object({
  url: z.string().min(1, 'required').url('invalidUrl').max(2000, 'tooLong'),
  events: z.array(z.string()).default([]),
  description: z.string().max(200, 'tooLong').optional(),
});

export type WebhookFormValues = z.infer<typeof webhookSchema>;

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  description?: string | null;
  status: 'ACTIVE' | 'DISABLED';
  failureCount?: number;
  lastDeliveryAt?: string | null;
  createdAt: string;
}

interface WebhookFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass an endpoint to edit, or null/undefined to create. */
  endpoint?: WebhookEndpoint | null;
  onSubmit: (values: WebhookFormValues) => void;
  isPending: boolean;
}

export function WebhookFormDialog({
  open,
  onOpenChange,
  endpoint,
  onSubmit,
  isPending,
}: WebhookFormDialogProps) {
  const { t } = useTranslation('marketing');
  const isEdit = !!endpoint;

  const form = useForm<WebhookFormValues>({
    resolver: zodResolver(webhookSchema),
    mode: 'onBlur',
    defaultValues: { url: '', events: [], description: '' },
  });

  useEffect(() => {
    if (!open) return;
    if (endpoint) {
      form.reset({
        url: endpoint.url,
        events: endpoint.events ?? [],
        description: endpoint.description ?? '',
      });
    } else {
      form.reset({ url: '', events: [], description: '' });
    }
  }, [open, endpoint, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('webhooks.editTitle', { defaultValue: 'Edit endpoint' })
              : t('webhooks.createTitle', { defaultValue: 'Add endpoint' })}
          </DialogTitle>
          <DialogDescription>
            {t('webhooks.formHint', {
              defaultValue:
                'We POST a signed JSON payload to this URL for each subscribed event. Leave events empty to receive all of them.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* URL */}
          <Field
            label={t('webhooks.fields.url', { defaultValue: 'Endpoint URL' })}
            error={fieldErr(errors.url?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="url"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                maxLength={2000}
                placeholder="https://example.com/webhooks/marketing"
                {...form.register('url')}
              />
            )}
          </Field>

          {/* Description */}
          <Field
            label={t('webhooks.fields.description', { defaultValue: 'Description' })}
            error={fieldErr(errors.description?.message)}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                maxLength={200}
                placeholder={t('webhooks.fields.descriptionPlaceholder', {
                  defaultValue: 'Optional note, e.g. "Zapier — new leads"',
                })}
                {...form.register('description')}
              />
            )}
          </Field>

          {/* Events */}
          <Field
            label={t('webhooks.fields.events', { defaultValue: 'Subscribed events' })}
            hint={t('webhooks.fields.eventsHint', {
              defaultValue: 'Select none to receive every event type.',
            })}
            error={fieldErr(errors.events?.message as string | undefined)}
          >
            {() => (
              <Controller
                control={form.control}
                name="events"
                render={({ field }) => (
                  <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    {WEBHOOK_EVENTS.map((evt) => {
                      const checked = field.value?.includes(evt) ?? false;
                      return (
                        <div key={evt} className="flex items-center gap-2">
                          <Checkbox
                            id={`evt-${evt}`}
                            checked={checked}
                            onCheckedChange={(v) => {
                              const next = v === true
                                ? [...(field.value ?? []), evt]
                                : (field.value ?? []).filter((e) => e !== evt);
                              field.onChange(next);
                            }}
                          />
                          <Label htmlFor={`evt-${evt}`} className="cursor-pointer font-mono text-xs">
                            {evt}
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                )}
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
              {isEdit
                ? t('common.save', { defaultValue: 'Save' })
                : t('webhooks.createButton', { defaultValue: 'Add endpoint' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
