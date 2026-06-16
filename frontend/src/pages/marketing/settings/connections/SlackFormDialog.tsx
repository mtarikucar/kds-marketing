import { useEffect } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Field,
  Input,
  Checkbox,
} from '@/components/ui';
import { slackCreateSchema, slackEditSchema } from './schemas';
import { SLACK_EVENTS, SLACK_EVENT_LABELS, type SlackEvent, type SlackIntegration } from './types';

/** Payload handed to the page (webhookUrl omitted on edit when left blank). */
export interface SlackSubmitPayload {
  webhookUrl?: string;
  channel?: string;
  events: SlackEvent[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass an integration to edit (webhook stays write-only), or null to create. */
  integration?: SlackIntegration | null;
  onSubmit: (payload: SlackSubmitPayload) => void;
  isPending: boolean;
}

interface FormShape {
  webhookUrl?: string;
  channel?: string;
  events: SlackEvent[];
}

const EMPTY: FormShape = { webhookUrl: '', channel: '', events: [] };

export function SlackFormDialog({ open, onOpenChange, integration, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!integration;

  const form = useForm<FormShape>({
    resolver: zodResolver(isEdit ? slackEditSchema : slackCreateSchema),
    mode: 'onBlur',
    defaultValues: EMPTY,
  });

  useEffect(() => {
    if (!open) return;
    if (integration) {
      form.reset({
        webhookUrl: '',
        channel: integration.channel ?? '',
        events: (integration.events ?? []).filter((e): e is SlackEvent =>
          (SLACK_EVENTS as readonly string[]).includes(e),
        ),
      });
    } else {
      form.reset(EMPTY);
    }
  }, [integration, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`connections.slack.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<FormShape> = (values) => {
    onSubmit({
      ...(values.webhookUrl && values.webhookUrl.trim() ? { webhookUrl: values.webhookUrl.trim() } : {}),
      ...(values.channel && values.channel.trim() ? { channel: values.channel.trim() } : {}),
      events: values.events,
    });
  };

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('connections.slack.editTitle', { defaultValue: 'Edit Slack integration' })
              : t('connections.slack.createTitle', { defaultValue: 'New Slack integration' })}
          </DialogTitle>
          <DialogDescription>
            {t('connections.slack.dialogDesc', {
              defaultValue: 'Post a message to a Slack channel when key events happen in your workspace.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field
            label={t('connections.slack.webhookUrl', { defaultValue: 'Incoming webhook URL' })}
            error={fieldErr(errors.webhookUrl?.message)}
            hint={
              isEdit
                ? t('connections.slack.webhookEditHint', {
                    defaultValue: 'Leave blank to keep the stored webhook. It is never displayed.',
                  })
                : t('connections.slack.webhookHint', {
                    defaultValue: 'From Slack → Incoming Webhooks. Stored securely and never displayed again.',
                  })
            }
            required={!isEdit}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                autoComplete="off"
                placeholder={isEdit ? '••••••••' : 'https://hooks.slack.com/services/...'}
                {...form.register('webhookUrl')}
              />
            )}
          </Field>

          <Field
            label={t('connections.slack.channel', { defaultValue: 'Channel (optional)' })}
            error={fieldErr(errors.channel?.message)}
            hint={t('connections.slack.channelHint', {
              defaultValue: 'Display label only, e.g. #sales-alerts. The webhook already targets a channel.',
            })}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="#sales-alerts"
                {...form.register('channel')}
              />
            )}
          </Field>

          <Controller
            control={form.control}
            name="events"
            render={({ field: f }) => {
              const toggle = (evt: SlackEvent, checked: boolean) => {
                const set = new Set(f.value);
                if (checked) set.add(evt);
                else set.delete(evt);
                f.onChange(Array.from(set));
              };
              return (
                <Field
                  label={t('connections.slack.events', { defaultValue: 'Notify on' })}
                  hint={t('connections.slack.eventsHint', {
                    defaultValue: 'Select which events post to Slack. None selected means all events.',
                  })}
                >
                  {() => (
                    <div className="space-y-2 rounded-lg border border-border p-3">
                      {SLACK_EVENTS.map((evt) => (
                        <label key={evt} className="flex items-center gap-2 text-sm text-foreground">
                          <Checkbox
                            checked={f.value.includes(evt)}
                            onCheckedChange={(c) => toggle(evt, c === true)}
                          />
                          {t(`connections.slack.eventLabels.${evt}`, {
                            defaultValue: SLACK_EVENT_LABELS[evt],
                          })}
                        </label>
                      ))}
                    </div>
                  )}
                </Field>
              );
            }}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit
                ? t('common.save', { defaultValue: 'Save' })
                : t('connections.slack.createTitle', { defaultValue: 'New Slack integration' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
