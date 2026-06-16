import { useEffect } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { offerSchema, type OfferFormValues } from '../../../features/marketing/schemas';
import type { LeadOffer, Lead } from '../../../features/marketing/types';
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
import { Textarea } from '@/components/ui/Textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

interface OfferFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass an existing offer to edit, or undefined/null to create. */
  offer?: LeadOffer | null;
  leads: Lead[];
  onSubmit: (values: OfferFormValues) => void;
  isPending: boolean;
}

/**
 * Create / Edit offer form dialog.
 * Uses react-hook-form + zodResolver(offerSchema).
 * Handles the plan-or-customPrice validation via the schema's .refine().
 */
export function OfferFormDialog({
  open,
  onOpenChange,
  offer,
  leads,
  onSubmit,
  isPending,
}: OfferFormDialogProps) {
  const { t } = useTranslation('marketing');
  const isEdit = !!offer;

  const form = useForm<OfferFormValues>({
    resolver: zodResolver(offerSchema),
    mode: 'onBlur',
    defaultValues: {
      leadId: '',
      planId: '',
      customPrice: undefined,
      discount: undefined,
      trialDays: undefined,
      validUntil: '',
      notes: '',
    },
  });

  // Populate / reset when dialog opens or offer changes
  useEffect(() => {
    if (open) {
      if (offer) {
        form.reset({
          leadId: offer.leadId ?? '',
          planId: offer.planId ?? '',
          customPrice: offer.customPrice ?? undefined,
          discount: offer.discount ?? undefined,
          trialDays: offer.trialDays ?? undefined,
          validUntil: offer.validUntil ? offer.validUntil.split('T')[0] : '',
          notes: offer.notes ?? '',
        });
      } else {
        form.reset({
          leadId: '',
          planId: '',
          customPrice: undefined,
          discount: undefined,
          trialDays: undefined,
          validUntil: '',
          notes: '',
        });
      }
    }
  }, [offer, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const errors = form.formState.errors;

  const handleSubmit: SubmitHandler<OfferFormValues> = (values) => {
    onSubmit(values);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `${t('common.edit')} ${t('offers.title')}` : t('offers.createButton')}
          </DialogTitle>
          <DialogDescription>{t('offers.subtitle')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          {/* Lead selector — only on create */}
          {!isEdit && (
            <Field
              label={t('offers.table.lead')}
              error={fieldErr(errors.leadId?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="leadId"
                  render={({ field }) => (
                    <Select value={field.value ?? ''} onValueChange={field.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue placeholder={t('common.selectPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {leads.map((l) => (
                          <SelectItem key={l.id} value={l.id}>
                            {l.businessName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            {/* Custom Price */}
            <Field
              label={t('offers.table.amount')}
              error={fieldErr(errors.customPrice?.message ?? (errors as any).planId?.message)}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  step="0.01"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="0.00"
                  {...form.register('customPrice', {
                    setValueAs: (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
                  })}
                />
              )}
            </Field>

            {/* Discount */}
            <Field
              label={t('offers.table.discount')}
              error={fieldErr(errors.discount?.message)}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={100}
                  step="1"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="0–100"
                  {...form.register('discount', {
                    setValueAs: (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
                  })}
                />
              )}
            </Field>

            {/* Trial Days */}
            <Field label="Trial Days" error={fieldErr(errors.trialDays?.message)}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={365}
                  step="1"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="0"
                  {...form.register('trialDays', {
                    setValueAs: (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
                  })}
                />
              )}
            </Field>

            {/* Valid Until */}
            <Field
              label={t('offers.table.validUntil')}
              error={fieldErr(errors.validUntil?.message)}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="date"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  {...form.register('validUntil')}
                />
              )}
            </Field>
          </div>

          {/* Notes */}
          <Field label="Notes" error={fieldErr(errors.notes?.message)}>
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="Optional notes…"
                rows={3}
                {...form.register('notes')}
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
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
