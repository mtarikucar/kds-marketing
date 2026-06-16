import { useEffect } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
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
  Textarea,
} from '@/components/ui';
import { createLocationSchema, type CreateLocationFormValues } from './schemas';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CreateLocationFormValues) => void;
  isPending: boolean;
}

const EMPTY: CreateLocationFormValues = {
  name: '',
  productName: '',
  productUrl: '',
  productDescription: '',
  language: '',
  currency: '',
  timezone: '',
  ownerEmail: '',
  ownerPassword: '',
  ownerFirstName: '',
  ownerLastName: '',
};

export function CreateLocationDialog({ open, onOpenChange, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');

  const form = useForm<CreateLocationFormValues>({
    resolver: zodResolver(createLocationSchema),
    mode: 'onBlur',
    defaultValues: EMPTY,
  });

  useEffect(() => {
    if (open) form.reset(EMPTY);
  }, [open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`agency.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<CreateLocationFormValues> = (values) => {
    // Drop empty optionals so the backend applies its defaults.
    const payload: CreateLocationFormValues = { ...values };
    (['productUrl', 'productDescription', 'language', 'currency', 'timezone'] as const).forEach((k) => {
      if (!payload[k]) delete payload[k];
    });
    onSubmit(payload);
  };
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('agency.locations.createTitle', { defaultValue: 'New sub-account' })}</DialogTitle>
          <DialogDescription>
            {t('agency.locations.createDesc', {
              defaultValue: 'Provision a child location with its product details and a first owner account.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('agency.locations.name', { defaultValue: 'Location name' })} error={fieldErr(errors.name?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder={t('agency.locations.namePlaceholder', { defaultValue: 'e.g. Acme Downtown' })} {...form.register('name')} />
              )}
            </Field>
            <Field label={t('agency.locations.productName', { defaultValue: 'Product / business name' })} error={fieldErr(errors.productName?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('productName')} />
              )}
            </Field>
          </div>

          <Field label={t('agency.locations.productUrl', { defaultValue: 'Product URL' })} error={fieldErr(errors.productUrl?.message)}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="https://…" {...form.register('productUrl')} />
            )}
          </Field>

          <Field label={t('agency.locations.productDescription', { defaultValue: 'Product description' })} error={fieldErr(errors.productDescription?.message)}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid} rows={2} {...form.register('productDescription')} />
            )}
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('agency.locations.language', { defaultValue: 'Language' })} error={fieldErr(errors.language?.message)} hint={t('agency.locations.defaultHint', { defaultValue: 'Optional' })}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="en" maxLength={8} {...form.register('language')} />
              )}
            </Field>
            <Field label={t('agency.locations.currency', { defaultValue: 'Currency' })} error={fieldErr(errors.currency?.message)}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="USD" maxLength={8} {...form.register('currency')} />
              )}
            </Field>
            <Field label={t('agency.locations.timezone', { defaultValue: 'Timezone' })} error={fieldErr(errors.timezone?.message)}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="UTC" maxLength={64} {...form.register('timezone')} />
              )}
            </Field>
          </div>

          <div className="rounded-lg border border-border bg-surface-muted/40 p-3">
            <p className="mb-3 text-sm font-medium text-foreground">
              {t('agency.locations.ownerSection', { defaultValue: 'First owner account' })}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('agency.locations.ownerFirstName', { defaultValue: 'First name' })} error={fieldErr(errors.ownerFirstName?.message)} required>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('ownerFirstName')} />
                )}
              </Field>
              <Field label={t('agency.locations.ownerLastName', { defaultValue: 'Last name' })} error={fieldErr(errors.ownerLastName?.message)} required>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('ownerLastName')} />
                )}
              </Field>
              <Field label={t('agency.locations.ownerEmail', { defaultValue: 'Owner email' })} error={fieldErr(errors.ownerEmail?.message)} required>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} type="email" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('ownerEmail')} />
                )}
              </Field>
              <Field label={t('agency.locations.ownerPassword', { defaultValue: 'Temporary password' })} error={fieldErr(errors.ownerPassword?.message)} hint={t('agency.locations.passwordHint', { defaultValue: 'At least 8 characters.' })} required>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('ownerPassword')} />
                )}
              </Field>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {t('agency.locations.create', { defaultValue: 'Create sub-account' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
