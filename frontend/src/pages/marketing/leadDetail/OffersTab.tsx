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
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { offerSchema, type OfferFormValues } from '../../../features/marketing/schemas';
import { formatMoney, asWorkspaceCurrency } from '../../../lib/money';
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
  /**
   * Render as a SECTION of the person's record card instead of a page card.
   *
   * The tab's own chrome — a full `Card` with a title bar — is page furniture:
   * inside the record card it would be a card in a card, with a second heading
   * competing with the one above it. So the chrome is a prop and the whole
   * body is not: the list, the create dialog, send, delete and both
   * confirmations are the same code on both surfaces, because they are the
   * same capability. `embedded` is the name this codebase already uses for
   * exactly this (`LeadsPage embedded`, `ChannelsSettingsPage embedded`).
   *
   * NOTE it does not carry loading or error state. The container owns the
   * query, so it owns the difference between "no offers" and "could not read
   * them" — this component only ever renders a settled, successful answer.
   */
  embedded?: boolean;
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
  embedded,
}: OffersTabProps) {
  const { t } = useTranslation('marketing');
  const [open, setOpen] = useState(false);
  const [confirmSendId, setConfirmSendId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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

  const addButton = !converted && (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => setOpen(true)}
      className="text-primary hover:text-primary"
    >
      <Plus className="h-4 w-4" /> {embedded ? t('surface.offers.add', 'Teklif') : 'New Offer'}
    </Button>
  );

  const list = (
    <>
      {(offers || []).length === 0 ? (
          embedded ? (
            // A settled, successful, EMPTY answer. The container renders the
            // failure, so these two states can never be read as one.
            <p data-testid="offers-empty" className="text-[11px] text-muted-foreground">
              {t('surface.offers.none', 'Bu kişiye teklif yok.')}
            </p>
          ) : (
            <EmptyState title="No offers yet" />
          )
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
                        {formatMoney(offer.customPrice, asWorkspaceCurrency(offer.planCurrency))}
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
                      onClick={() => setConfirmSendId(offer.id)}
                    >
                      <Send className="h-3.5 w-3.5" /> Send
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="border-danger/40 text-danger hover:bg-danger-subtle"
                      onClick={() => setConfirmDeleteId(offer.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </>
  );

  const dialogs = (
    <>
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

      <ConfirmDialog
        open={confirmSendId !== null}
        onOpenChange={(o) => { if (!o) setConfirmSendId(null); }}
        title={t('offers.sendConfirm.title', 'Send this offer to the customer?')}
        description={t('offers.sendConfirm.desc', 'The price quote is transmitted to the customer and cannot be unsent.')}
        confirmLabel={t('offers.sendConfirm.confirm', 'Send')}
        cancelLabel={t('common.cancel', 'Cancel')}
        onConfirm={() => {
          if (confirmSendId) onSend(confirmSendId);
          setConfirmSendId(null);
        }}
      />

      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteId(null); }}
        tone="danger"
        title={t('offers.deleteConfirm.title', 'Delete this offer?')}
        description={t('offers.deleteConfirm.desc', 'The offer is removed from this lead. This cannot be undone.')}
        confirmLabel={t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        onConfirm={() => {
          if (confirmDeleteId) onDelete(confirmDeleteId);
          setConfirmDeleteId(null);
        }}
      />
    </>
  );

  // The record card's section chrome: the same small uppercase heading the
  // SATIŞ section uses, so five sections read as one card rather than five.
  if (embedded) {
    return (
      <section data-testid="record-offers" className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('surface.offers.title', 'Teklifler')}
          </h4>
          {addButton}
        </div>
        {list}
        {dialogs}
      </section>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Offers</CardTitle>
        {addButton}
      </CardHeader>
      <CardContent>{list}</CardContent>
      {dialogs}
    </Card>
  );
}
