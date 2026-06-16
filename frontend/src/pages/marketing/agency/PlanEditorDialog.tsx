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
  Switch,
  Label,
} from '@/components/ui';
import { rebillingPlanSchema, type RebillingPlanFormValues } from './schemas';
import type { Location, RebillingPlan } from './types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: Location | null;
  /** Existing plan for the location, or null to create. */
  plan: RebillingPlan | null;
  onSubmit: (values: RebillingPlanFormValues) => void;
  isPending: boolean;
}

const EMPTY: RebillingPlanFormValues = {
  basePrice: '0',
  usageUnitPrice: '0',
  markupPercent: '0',
  enabled: true,
};

export function PlanEditorDialog({ open, onOpenChange, location, plan, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');

  const form = useForm<RebillingPlanFormValues>({
    resolver: zodResolver(rebillingPlanSchema),
    mode: 'onBlur',
    defaultValues: EMPTY,
  });

  useEffect(() => {
    if (!open) return;
    if (plan) {
      form.reset({
        basePrice: String(plan.basePrice),
        usageUnitPrice: String(plan.usageUnitPrice),
        markupPercent: String(plan.markupPercent),
        enabled: plan.enabled,
      });
    } else {
      form.reset(EMPTY);
    }
  }, [open, plan, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`agency.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<RebillingPlanFormValues> = (values) => onSubmit(values);
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {plan
              ? t('agency.rebilling.editPlan', { defaultValue: 'Edit rebilling plan' })
              : t('agency.rebilling.newPlan', { defaultValue: 'New rebilling plan' })}
          </DialogTitle>
          <DialogDescription>
            {location
              ? t('agency.rebilling.planDesc', {
                  defaultValue: 'Set the monthly SaaS fee and usage markup for “{{name}}”.',
                  name: location.name,
                })
              : ''}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field
            label={t('agency.rebilling.basePrice', { defaultValue: 'Base price (monthly)' })}
            error={fieldErr(errors.basePrice?.message)}
            hint={t('agency.rebilling.basePriceHint', { defaultValue: 'Flat fee charged each period, in TRY.' })}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="number" step="0.01" min="0" inputMode="decimal" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('basePrice')} />
            )}
          </Field>

          <Field
            label={t('agency.rebilling.usageUnitPrice', { defaultValue: 'Usage unit price' })}
            error={fieldErr(errors.usageUnitPrice?.message)}
            hint={t('agency.rebilling.usageUnitPriceHint', { defaultValue: 'Price per metered usage unit (AI credits + messages).' })}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="number" step="0.01" min="0" inputMode="decimal" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('usageUnitPrice')} />
            )}
          </Field>

          <Field
            label={t('agency.rebilling.markupPercent', { defaultValue: 'Markup %' })}
            error={fieldErr(errors.markupPercent?.message)}
            hint={t('agency.rebilling.markupPercentHint', { defaultValue: 'Markup added on metered usage, e.g. 20 = +20%.' })}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="number" step="0.01" min="0" inputMode="decimal" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('markupPercent')} />
            )}
          </Field>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <div>
              <Label htmlFor="plan-enabled">{t('agency.rebilling.enabled', { defaultValue: 'Plan enabled' })}</Label>
              <p className="text-caption text-muted-foreground">
                {t('agency.rebilling.enabledHint', { defaultValue: 'Disabled plans block charge computation.' })}
              </p>
            </div>
            <Controller
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <Switch id="plan-enabled" checked={field.value} onCheckedChange={field.onChange} />
              )}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {t('common.save', { defaultValue: 'Save' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
