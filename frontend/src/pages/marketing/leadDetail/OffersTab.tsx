import { useEffect, useState } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { Plus, Send, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import type { BadgeProps } from '@/components/ui/Badge';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { offerSchema, type OfferFormValues } from '../../../features/marketing/schemas';
import { formatMoney } from '../../../lib/money';
import type { LeadOffer } from '../../../features/marketing/types';

const offerStatusTone: Record<string, BadgeProps['tone']> = {
  DRAFT: 'neutral',
  SENT: 'info',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
};

interface OffersTabProps {
  leadId: string;
  offers: LeadOffer[];
  converted: boolean;
  fmtDate: (d: string | Date | null | undefined) => string;
  onCreate: (data: Record<string, unknown>) => void;
  createPending: boolean;
  onSend: (offerId: string) => void;
  onDelete: (offerId: string) => void;
}

export default function OffersTab({
  leadId,
  offers,
  converted,
  fmtDate,
  onCreate,
  createPending,
  onSend,
  onDelete,
}: OffersTabProps) {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);

  const form = useForm<OfferFormValues>({
    resolver: zodResolver(offerSchema),
    mode: 'onBlur',
    defaultValues: {
      leadId,
      customPrice: '' as unknown as undefined,
      discount: '' as unknown as undefined,
      trialDays: '' as unknown as undefined,
      validUntil: '',
      notes: '',
    },
  });

  // The lead-detail route REUSES this tab across /leads/:id navigations (no
  // remount, like WalletPanel), so without this a half-typed offer (custom
  // price/discount/notes) for one contact would stay in the open form and be
  // submitted against the NEXT contact. Clear + close the draft when the lead
  // changes so a draft can never carry to the wrong lead.
  useEffect(() => {
    form.reset({
      leadId,
      customPrice: '' as unknown as undefined,
      discount: '' as unknown as undefined,
      trialDays: '' as unknown as undefined,
      validUntil: '',
      notes: '',
    });
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  // Mirror the original payload shape: only send keys that were filled in.
  const submit: SubmitHandler<OfferFormValues> = (values) => {
    onCreate({
      leadId,
      ...(values.customPrice != null ? { customPrice: Number(values.customPrice) } : {}),
      ...(values.discount != null ? { discount: Number(values.discount) } : {}),
      ...(values.trialDays != null ? { trialDays: Number(values.trialDays) } : {}),
      ...(values.validUntil ? { validUntil: values.validUntil } : {}),
      ...(values.notes ? { notes: values.notes } : {}),
    });
    form.reset({
      leadId,
      customPrice: '' as unknown as undefined,
      discount: '' as unknown as undefined,
      trialDays: '' as unknown as undefined,
      validUntil: '',
      notes: '',
    });
    setOpen(false);
  };

  // Empty string → undefined so optional numeric fields stay valid; otherwise Number.
  const numberSetValueAs = (v: string) => (v === '' ? '' : Number(v));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Offers</CardTitle>
        {!converted && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(true)}
            className="text-primary hover:text-primary"
          >
            <Plus className="h-4 w-4" /> New Offer
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {(offers || []).length === 0 ? (
          <EmptyState title="No offers yet" />
        ) : (
          <div className="space-y-3">
            {(offers || []).map((offer) => (
              <div key={offer.id} className="rounded-lg border border-border p-4">
                <div className="mb-2 flex items-center justify-between">
                  <Badge tone={offerStatusTone[offer.status] ?? 'neutral'} size="sm">
                    {offer.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{fmtDate(offer.createdAt)}</span>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                  {/* `!!` so a numeric 0 (e.g. trialDays) coerces to false and
                      hides the cell — a bare `{value && …}` would render a
                      stray literal "0" into the card. */}
                  {!!offer.customPrice && (
                    <div>
                      <span className="text-muted-foreground">Price:</span>{' '}
                      <span className="font-medium text-foreground">
                        {formatMoney(offer.customPrice)}
                      </span>
                    </div>
                  )}
                  {!!offer.discount && (
                    <div>
                      <span className="text-muted-foreground">Discount:</span>{' '}
                      <span className="font-medium text-foreground">{offer.discount}%</span>
                    </div>
                  )}
                  {!!offer.trialDays && (
                    <div>
                      <span className="text-muted-foreground">Trial:</span>{' '}
                      <span className="font-medium text-foreground">{offer.trialDays} days</span>
                    </div>
                  )}
                </div>
                {offer.validUntil && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    Valid until: {fmtDate(offer.validUntil)}
                  </p>
                )}
                {offer.notes && <p className="mb-3 text-sm text-muted-foreground">{offer.notes}</p>}
                {offer.status === 'DRAFT' && (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        // Sending transmits the price quote to the customer and
                        // can't be unsent — confirm first, like the delete below.
                        if (window.confirm('Send this offer to the customer?')) {
                          onSend(offer.id);
                        }
                      }}
                    >
                      <Send className="h-3.5 w-3.5" /> Send
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="border-danger/40 text-danger hover:bg-danger-subtle"
                      onClick={() => {
                        if (window.confirm('Delete this offer?')) onDelete(offer.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Offer</DialogTitle>
            <DialogDescription>Create a draft offer for this lead.</DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Custom Price" error={fieldErr(form.formState.errors.customPrice?.message)}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    {...form.register('customPrice', { setValueAs: numberSetValueAs })}
                  />
                )}
              </Field>
              <Field label="Discount (%)" error={fieldErr(form.formState.errors.discount?.message)}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="number"
                    placeholder="0"
                    {...form.register('discount', { setValueAs: numberSetValueAs })}
                  />
                )}
              </Field>
              <Field label="Trial Days" error={fieldErr(form.formState.errors.trialDays?.message)}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="number"
                    placeholder="14"
                    {...form.register('trialDays', { setValueAs: numberSetValueAs })}
                  />
                )}
              </Field>
              <Field label="Valid Until" error={fieldErr(form.formState.errors.validUntil?.message)}>
                {({ id, describedBy }) => (
                  <Input id={id} aria-describedby={describedBy} type="date" {...form.register('validUntil')} />
                )}
              </Field>
            </div>
            <Field label="Notes" error={fieldErr(form.formState.errors.notes?.message)}>
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  rows={2}
                  placeholder="Notes"
                  {...form.register('notes')}
                />
              )}
            </Field>
            {/* planOrPriceRequired surfaces on planId — show it here. */}
            {form.formState.errors.planId && (
              <p className="text-caption text-danger" role="alert">
                {fieldErr(form.formState.errors.planId.message)}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={createPending}>
                Create Offer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
