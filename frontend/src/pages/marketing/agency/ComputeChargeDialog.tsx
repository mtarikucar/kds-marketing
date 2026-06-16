import { useEffect, useState } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Calculator, AlertTriangle } from 'lucide-react';
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
  Callout,
} from '@/components/ui';
import { useRebillingMutations } from './hooks';
import { computeChargeSchema, type ComputeChargeFormValues } from './schemas';
import type { Location, RebillCharge } from './types';
import { apiError, dateInputToIso, formatMoney, isRebillingNotConfigured } from './util';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: Location | null;
}

export function ComputeChargeDialog({ open, onOpenChange, location }: Props) {
  const { t } = useTranslation('marketing');
  const { computeCharge, settleCharge } = useRebillingMutations();

  const [charge, setCharge] = useState<RebillCharge | null>(null);
  // The env-gated live charge: when the backend returns REBILLING_NOT_CONFIGURED
  // we show a clean, explicit banner rather than treating it as a failure.
  const [notConfigured, setNotConfigured] = useState(false);

  const form = useForm<ComputeChargeFormValues>({
    resolver: zodResolver(computeChargeSchema),
    mode: 'onBlur',
    defaultValues: { periodStart: '', periodEnd: '' },
  });

  useEffect(() => {
    if (open) {
      form.reset({ periodStart: '', periodEnd: '' });
      setCharge(null);
      setNotConfigured(false);
    }
  }, [open, location?.id, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`agency.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleCompute: SubmitHandler<ComputeChargeFormValues> = (values) => {
    if (!location) return;
    setNotConfigured(false);
    computeCharge.mutate(
      {
        locationId: location.id,
        periodStart: dateInputToIso(values.periodStart),
        periodEnd: dateInputToIso(values.periodEnd),
      },
      {
        onSuccess: (c) => {
          setCharge(c);
          toast.success(t('agency.rebilling.computed', { defaultValue: 'Charge computed' }));
        },
        onError: (e) => toast.error(apiError(e, t('agency.rebilling.computeError', { defaultValue: 'Failed to compute charge' }))),
      },
    );
  };

  const handleSettle = () => {
    if (!charge) return;
    setNotConfigured(false);
    settleCharge.mutate(charge.id, {
      onSuccess: (c) => {
        setCharge(c);
        toast.success(t('agency.rebilling.settled', { defaultValue: 'Charge settled' }));
      },
      onError: (e) => {
        if (isRebillingNotConfigured(e)) {
          // Clean, expected state — Stripe Connect is not configured. Never a crash.
          setNotConfigured(true);
          return;
        }
        toast.error(apiError(e, t('agency.rebilling.settleError', { defaultValue: 'Failed to settle charge' })));
      },
    });
  };

  const currency = location?.defaultCurrency ?? 'TRY';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('agency.rebilling.computeTitle', { defaultValue: 'Compute charge' })}</DialogTitle>
          <DialogDescription>
            {location
              ? t('agency.rebilling.computeDesc', {
                  defaultValue: 'Compute a settlement line for “{{name}}” over a billing period.',
                  name: location.name,
                })
              : ''}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleCompute)} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('agency.rebilling.periodStart', { defaultValue: 'Period start' })} error={fieldErr(form.formState.errors.periodStart?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="date" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('periodStart')} />
              )}
            </Field>
            <Field label={t('agency.rebilling.periodEnd', { defaultValue: 'Period end' })} error={fieldErr(form.formState.errors.periodEnd?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="date" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('periodEnd')} />
              )}
            </Field>
          </div>

          <Button type="submit" variant="outline" loading={computeCharge.isPending} className="w-full">
            <Calculator className="h-4 w-4" aria-hidden="true" />
            {t('agency.rebilling.compute', { defaultValue: 'Compute' })}
          </Button>
        </form>

        {charge && (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">{t('agency.rebilling.base', { defaultValue: 'Base' })}</dt>
                <dd className="tabular-nums text-foreground">{formatMoney(charge.baseAmount, currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">
                  {t('agency.rebilling.usage', { defaultValue: 'Usage' })}{' '}
                  <span className="text-xs">({charge.usageUnits} {t('agency.rebilling.units', { defaultValue: 'units' })})</span>
                </dt>
                <dd className="tabular-nums text-foreground">{formatMoney(charge.usageAmount, currency)}</dd>
              </div>
              <div className="flex justify-between border-t border-border pt-2 font-medium">
                <dt className="text-foreground">{t('agency.rebilling.total', { defaultValue: 'Total' })}</dt>
                <dd className="tabular-nums text-foreground">{formatMoney(charge.totalAmount, currency)}</dd>
              </div>
            </dl>

            {notConfigured && (
              <Callout tone="warning" icon={<AlertTriangle className="h-4 w-4" />}>
                {t('agency.rebilling.notConfigured', {
                  defaultValue: 'Rebilling not configured. Set STRIPE_CONNECT_CLIENT_ID and STRIPE_SECRET_KEY (and connect the location’s Stripe account) to charge live. The settlement line is still recorded.',
                })}
              </Callout>
            )}

            <Button type="button" onClick={handleSettle} loading={settleCharge.isPending} className="w-full" disabled={charge.status === 'PAID' || charge.status === 'INVOICED'}>
              {charge.status === 'PAID' || charge.status === 'INVOICED'
                ? t('agency.rebilling.alreadySettled', { defaultValue: 'Already settled' })
                : t('agency.rebilling.settle', { defaultValue: 'Charge via Stripe Connect' })}
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close', { defaultValue: 'Close' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
