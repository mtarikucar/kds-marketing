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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { affiliateSchema, type AffiliateFormValues } from '../schemas';
import type { Affiliate } from '../types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass an affiliate to edit, or null to create. */
  affiliate?: Affiliate | null;
  onSubmit: (values: AffiliateFormValues) => void;
  isPending: boolean;
}

const EMPTY: AffiliateFormValues = {
  name: '',
  email: '',
  code: '',
  commissionType: 'PERCENT',
  commissionValue: 10,
  status: 'ACTIVE',
};

export function AffiliateFormDialog({ open, onOpenChange, affiliate, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!affiliate;

  const form = useForm<AffiliateFormValues>({
    resolver: zodResolver(affiliateSchema),
    mode: 'onBlur',
    defaultValues: EMPTY,
  });

  useEffect(() => {
    if (!open) return;
    if (affiliate) {
      form.reset({
        name: affiliate.name,
        email: affiliate.email,
        code: affiliate.code,
        commissionType: affiliate.commissionType,
        commissionValue: Number(affiliate.commissionValue),
        status: affiliate.status,
      });
    } else {
      form.reset(EMPTY);
    }
  }, [affiliate, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`affiliates.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<AffiliateFormValues> = (values) => onSubmit(values);
  const errors = form.formState.errors;
  const commissionType = form.watch('commissionType');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('affiliates.editTitle', { defaultValue: 'Edit affiliate' })
              : t('affiliates.createTitle', { defaultValue: 'New affiliate' })}
          </DialogTitle>
          <DialogDescription>
            {t('affiliates.dialogDesc', {
              defaultValue: 'Affiliates earn a commission on converted referrals tracked to their code.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field label={t('affiliates.name', { defaultValue: 'Name' })} error={fieldErr(errors.name?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('affiliates.namePlaceholder', { defaultValue: 'e.g. Acme Partners' })}
                {...form.register('name')}
              />
            )}
          </Field>

          <Field label={t('affiliates.email', { defaultValue: 'Email' })} error={fieldErr(errors.email?.message)} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="email"
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="partner@example.com"
                {...form.register('email')}
              />
            )}
          </Field>

          <Field
            label={t('affiliates.code', { defaultValue: 'Referral code' })}
            error={fieldErr(errors.code?.message)}
            hint={t('affiliates.codeHint', { defaultValue: 'Letters, numbers, dashes and underscores. Unique per workspace.' })}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="ACME10"
                {...form.register('code')}
              />
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t('affiliates.commissionType', { defaultValue: 'Commission type' })}
              error={fieldErr(errors.commissionType?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="commissionType"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="PERCENT">
                          {t('affiliates.type.PERCENT', { defaultValue: 'Percent (%)' })}
                        </SelectItem>
                        <SelectItem value="FLAT">
                          {t('affiliates.type.FLAT', { defaultValue: 'Flat amount' })}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>

            <Field
              label={
                commissionType === 'PERCENT'
                  ? t('affiliates.commissionPercent', { defaultValue: 'Rate (%)' })
                  : t('affiliates.commissionAmount', { defaultValue: 'Amount' })
              }
              error={fieldErr(errors.commissionValue?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  step="0.01"
                  min={0}
                  max={commissionType === 'PERCENT' ? 100 : undefined}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  {...form.register('commissionValue')}
                />
              )}
            </Field>
          </div>

          {isEdit && (
            <Field label={t('affiliates.status', { defaultValue: 'Status' })} error={fieldErr(errors.status?.message)}>
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ACTIVE">{t('affiliates.statusValue.ACTIVE', { defaultValue: 'Active' })}</SelectItem>
                        <SelectItem value="PAUSED">{t('affiliates.statusValue.PAUSED', { defaultValue: 'Paused' })}</SelectItem>
                        <SelectItem value="DISABLED">{t('affiliates.statusValue.DISABLED', { defaultValue: 'Disabled' })}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit
                ? t('common.save', { defaultValue: 'Save' })
                : t('affiliates.createTitle', { defaultValue: 'New affiliate' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
