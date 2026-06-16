import { useEffect } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { connectAccountSchema, type ConnectAccountFormValues, SOCIAL_NETWORKS } from './socialSchemas';
import { NETWORK_META } from './networks';
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
import { Callout } from '@/components/ui/Callout';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

interface ConnectAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ConnectAccountFormValues) => void;
  isPending: boolean;
  /** When false, the backend cannot seal tokens — connecting is blocked. */
  secretBoxConfigured: boolean;
}

export function ConnectAccountDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  secretBoxConfigured,
}: ConnectAccountDialogProps) {
  const { t } = useTranslation('marketing');

  const form = useForm<ConnectAccountFormValues>({
    resolver: zodResolver(connectAccountSchema),
    mode: 'onBlur',
    defaultValues: {
      network: 'FACEBOOK',
      externalId: '',
      displayName: '',
      accessToken: '',
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({ network: 'FACEBOOK', externalId: '', displayName: '', accessToken: '' });
    }
  }, [open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<ConnectAccountFormValues> = (values) => {
    onSubmit(values);
  };

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('social.connect.title', { defaultValue: 'Connect social account' })}
          </DialogTitle>
          <DialogDescription>
            {t('social.connect.subtitle', {
              defaultValue: 'Link a page or profile so the planner can publish to it.',
            })}
          </DialogDescription>
        </DialogHeader>

        {!secretBoxConfigured && (
          <Callout tone="warning">
            {t('social.connect.noSecretBox', {
              defaultValue:
                'Token encryption is not configured on the server (MARKETING_SECRET_KEY). Accounts cannot be connected until an administrator enables it.',
            })}
          </Callout>
        )}

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          {/* Network */}
          <Field
            label={t('social.connect.network', { defaultValue: 'Network' })}
            error={fieldErr(errors.network?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Controller
                control={form.control}
                name="network"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SOCIAL_NETWORKS.map((net) => (
                        <SelectItem key={net} value={net}>
                          {NETWORK_META[net].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </Field>

          {/* Display name */}
          <Field
            label={t('social.connect.displayName', { defaultValue: 'Display name' })}
            error={fieldErr(errors.displayName?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('social.connect.displayNamePlaceholder', {
                  defaultValue: 'e.g. Acme Co — Facebook Page',
                })}
                {...form.register('displayName')}
              />
            )}
          </Field>

          {/* External id */}
          <Field
            label={t('social.connect.externalId', { defaultValue: 'External ID' })}
            hint={t('social.connect.externalIdHint', {
              defaultValue: 'The provider page or profile id this account publishes as.',
            })}
            error={fieldErr(errors.externalId?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="123456789"
                {...form.register('externalId')}
              />
            )}
          </Field>

          {/* Access token */}
          <Field
            label={t('social.connect.accessToken', { defaultValue: 'Access token' })}
            hint={t('social.connect.accessTokenHint', {
              defaultValue: 'Stored encrypted and masked — it is never shown again after saving.',
            })}
            error={fieldErr(errors.accessToken?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="password"
                autoComplete="off"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="••••••••••••"
                {...form.register('accessToken')}
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
            <Button type="submit" loading={isPending} disabled={!secretBoxConfigured}>
              {t('social.connect.submit', { defaultValue: 'Connect' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
