import { useEffect } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import {
  connectAdAccountSchema,
  type ConnectAdAccountFormValues,
  AD_PROVIDERS,
  AD_PROVIDER_LABEL,
} from './adsSchemas';
import type { AdProviderStatus } from '../../../features/marketing/api/ads.service';
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

interface ConnectAdAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ConnectAdAccountFormValues) => void;
  isPending: boolean;
  /** Per-provider availability + whether the server can seal tokens. */
  status?: AdProviderStatus;
}

export function ConnectAdAccountDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  status,
}: ConnectAdAccountDialogProps) {
  const { t } = useTranslation('marketing');
  const secretBoxConfigured = status ? status.secretBoxConfigured : true;

  const form = useForm<ConnectAdAccountFormValues>({
    resolver: zodResolver(connectAdAccountSchema),
    mode: 'onBlur',
    defaultValues: { provider: 'META', externalAdId: '', displayName: '', accessToken: '', currency: '' },
  });

  useEffect(() => {
    if (open) {
      form.reset({ provider: 'META', externalAdId: '', displayName: '', accessToken: '', currency: '' });
    }
  }, [open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<ConnectAdAccountFormValues> = (values) => {
    // Strip empty optionals so the backend keeps its own defaults.
    onSubmit({
      ...values,
      displayName: values.displayName?.trim() || undefined,
      currency: values.currency?.trim() || undefined,
    });
  };

  const errors = form.formState.errors;
  const provider = form.watch('provider');
  const providerConfigured = status ? status[provider] : true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('ads.connect.title', { defaultValue: 'Connect ad account' })}</DialogTitle>
          <DialogDescription>
            {t('ads.connect.subtitle', {
              defaultValue: 'Link your Meta or TikTok ad account to pull spend and conversion metrics.',
            })}
          </DialogDescription>
        </DialogHeader>

        {!secretBoxConfigured && (
          <Callout tone="warning">
            {t('ads.connect.noSecretBox', {
              defaultValue:
                'Token encryption is not configured on the server (MARKETING_SECRET_KEY). Accounts cannot be connected until an administrator enables it.',
            })}
          </Callout>
        )}

        {secretBoxConfigured && !providerConfigured && (
          <Callout tone="warning">
            {t('ads.connect.providerUnavailable', {
              defaultValue:
                'This provider is not configured on the platform yet. Connecting it will not pull data until an administrator enables its app credentials.',
            })}
          </Callout>
        )}

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          {/* Provider */}
          <Field
            label={t('ads.connect.provider', { defaultValue: 'Provider' })}
            error={fieldErr(errors.provider?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Controller
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AD_PROVIDERS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {AD_PROVIDER_LABEL[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </Field>

          {/* External ad id */}
          <Field
            label={t('ads.connect.externalAdId', { defaultValue: 'Ad account ID' })}
            hint={
              provider === 'META'
                ? t('ads.connect.metaIdHint', { defaultValue: 'Your Meta ad account id (act_… or the number).' })
                : t('ads.connect.tiktokIdHint', { defaultValue: 'Your TikTok advertiser_id.' })
            }
            error={fieldErr(errors.externalAdId?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={provider === 'META' ? 'act_1234567890' : '7000000000000000000'}
                {...form.register('externalAdId')}
              />
            )}
          </Field>

          {/* Display name */}
          <Field
            label={t('ads.connect.displayName', { defaultValue: 'Display name' })}
            hint={t('ads.connect.displayNameHint', { defaultValue: 'Optional — defaults to the account id.' })}
            error={fieldErr(errors.displayName?.message)}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('ads.connect.displayNamePlaceholder', { defaultValue: 'e.g. Acme — Meta Ads' })}
                {...form.register('displayName')}
              />
            )}
          </Field>

          {/* Currency */}
          <Field
            label={t('ads.connect.currency', { defaultValue: 'Currency' })}
            hint={t('ads.connect.currencyHint', { defaultValue: 'Optional — the account currency (e.g. USD, TRY).' })}
            error={fieldErr(errors.currency?.message)}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="USD"
                {...form.register('currency')}
              />
            )}
          </Field>

          {/* Access token */}
          <Field
            label={t('ads.connect.accessToken', { defaultValue: 'Access token' })}
            hint={t('ads.connect.accessTokenHint', {
              defaultValue: 'Stored encrypted — it is never shown again after saving.',
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
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending} disabled={!secretBoxConfigured || !providerConfigured}>
              {t('ads.connect.submit', { defaultValue: 'Connect' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
