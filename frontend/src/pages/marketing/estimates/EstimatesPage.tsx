import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Trash2, Send, Check, X, FileOutput, Pencil } from 'lucide-react';

import {
  listEstimates,
  getEstimate,
  createEstimate,
  updateEstimate,
  sendEstimate,
  acceptEstimate,
  declineEstimate,
  convertEstimate,
  deleteEstimate,
  type Estimate,
  type EstimateStatus,
} from '../../../features/marketing/api/estimates.service';
import {
  PageHeader,
  Button,
  Card,
  CardContent,
  Badge,
  QueryStateBoundary,
  EmptyState,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Input,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui';
import { listProducts } from '../../../features/marketing/api/products.service';
import { listTaxRates } from '../../../features/marketing/api/tax-rates.service';

const NO_TAX = '__none__';

const STATUS_TONE: Record<EstimateStatus, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  DRAFT: 'neutral',
  SENT: 'info',
  ACCEPTED: 'success',
  DECLINED: 'danger',
  EXPIRED: 'warning',
};

interface ItemRow {
  description: string;
  qty: string;
  price: string; // major units in the form; converted to minor on save
  taxRateId?: string; // optional per-line tax rate (mirrors the invoice form)
}

interface FormState {
  id?: string;
  status?: EstimateStatus;
  currency: string;
  notes: string;
  validUntil: string;
  items: ItemRow[];
}

const EMPTY_ITEM: ItemRow = { description: '', qty: '1', price: '' };
const EMPTY_FORM: FormState = {
  currency: 'TRY',
  notes: '',
  validUntil: '',
  items: [{ ...EMPTY_ITEM }],
};

/**
 * Map a full estimate record (the GET /:id detail) into the editor's form
 * state. The list endpoint omits `items` and `notes`, so the edit dialog MUST
 * build the form from the detail — seeding from a list row would open the
 * editor with no line items, and saving a DRAFT would then replace the
 * estimate's items with an empty set (and wipe its notes). Prices are
 * minor→major for the form.
 */
export function formFromEstimate(e: Estimate): FormState {
  return {
    id: e.id,
    status: e.status,
    currency: e.currency,
    notes: e.notes ?? '',
    validUntil: e.validUntil ? e.validUntil.slice(0, 10) : '',
    items: (e.items ?? []).map((it) => ({
      description: it.description,
      qty: String(it.qty),
      price: String((it.unitPrice || 0) / 100),
      taxRateId: it.taxRateId ?? undefined,
    })),
  };
}

/**
 * The exact line items an estimate will PERSIST: blank-description rows are
 * dropped and qty/price are normalized to non-negative minor-unit integers.
 * Both the save payload and the live total preview derive from this, so the
 * editor can never show a figure different from what the server stores.
 */
export function normalizeEstimateItems(
  items: ItemRow[],
): { description: string; qty: number; unitPrice: number; taxRateId?: string }[] {
  return items
    .filter((it) => it.description.trim())
    .map((it) => ({
      description: it.description.trim(),
      qty: Math.max(0, Math.round(Number(it.qty) || 0)),
      unitPrice: Math.max(0, Math.round(Number(it.price) * 100 || 0)),
      ...(it.taxRateId ? { taxRateId: it.taxRateId } : {}),
    }));
}

/**
 * Minor-unit subtotal / tax / total over the PERSISTED items — exclusive tax,
 * rounded per line then summed, mirroring the backend computeMoneyTotals.
 */
export function computeFormTotals(
  items: ItemRow[],
  pctOf: (taxRateId?: string) => number,
): { subtotal: number; tax: number; total: number } {
  let subtotal = 0;
  let tax = 0;
  for (const it of normalizeEstimateItems(items)) {
    const line = it.qty * it.unitPrice;
    subtotal += line;
    tax += Math.round((line * pctOf(it.taxRateId)) / 100);
  }
  return { subtotal, tax, total: subtotal + tax };
}

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      (minor || 0) / 100,
    );
  } catch {
    return `${(minor || 0) / 100} ${currency}`;
  }
}

function Labeled({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={['space-y-1.5', className].filter(Boolean).join(' ')}>
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

/**
 * Estimates / quotes (GoHighLevel parity). List + a line-item editor; send to
 * the customer, mark accepted/declined, and convert an accepted estimate into an
 * invoice. Reps manage their own quotes (leads.write); the backend scopes data.
 */
export default function EstimatesPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const { data: estimates, isLoading, isError, refetch } = useQuery({
    queryKey: ['marketing', 'estimates'],
    queryFn: listEstimates,
  });

  // Catalog for the "add from product" picker in the line-item editor.
  const { data: productPage } = useQuery({
    queryKey: ['marketing', 'products', 'active'],
    queryFn: () => listProducts({ active: true, limit: 100 }),
    staleTime: 60_000,
  });
  const products = productPage?.data ?? [];

  // Per-line tax rates (KDV/VAT) — same source the invoice form uses, so a quote
  // and the invoice it converts into apply identical tax.
  const { data: taxRates = [] } = useQuery({
    queryKey: ['marketing', 'tax-rates'],
    queryFn: listTaxRates,
    staleTime: 60_000,
  });
  const pctOf = (taxRateId?: string) => Number(taxRates.find((r) => r.id === taxRateId)?.rate ?? 0);

  const addProductLine = (productId: string) => {
    const p = products.find((x) => x.id === productId);
    if (!p) return;
    setForm((f) => ({
      ...f,
      currency: f.items.some((it) => it.description.trim()) ? f.currency : p.currency,
      items: [
        ...f.items.filter((it) => it.description.trim() || it.price),
        { description: p.name, qty: '1', price: String(Number(p.price) || 0) },
      ],
    }));
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'estimates'] });
  const onError = (e: unknown) =>
    toast.error(
      (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        t('estimates.saveError', 'Could not save the estimate'),
    );

  const buildPayload = (f: FormState) => ({
    currency: f.currency,
    notes: f.notes || undefined,
    validUntil: f.validUntil || undefined,
    items: normalizeEstimateItems(f.items),
  });

  const saveMutation = useMutation({
    mutationFn: (f: FormState) =>
      f.id ? updateEstimate(f.id, buildPayload(f)) : createEstimate(buildPayload(f)),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      toast.success(t('estimates.saved', 'Saved'));
    },
    onError,
  });

  const sendMut = useMutation({
    mutationFn: sendEstimate,
    onSuccess: () => {
      invalidate();
      toast.success(t('estimates.sent', 'Estimate sent'));
    },
    onError,
  });
  const acceptMut = useMutation({
    mutationFn: acceptEstimate,
    onSuccess: () => {
      invalidate();
      toast.success(t('estimates.accepted', 'Marked accepted'));
    },
    onError,
  });
  const declineMut = useMutation({
    mutationFn: declineEstimate,
    onSuccess: () => {
      invalidate();
      toast.success(t('estimates.declined', 'Marked declined'));
    },
    onError,
  });
  const deleteMut = useMutation({
    mutationFn: deleteEstimate,
    onSuccess: () => {
      invalidate();
      toast.success(t('estimates.deleted', 'Estimate deleted'));
    },
    onError,
  });
  const convertMut = useMutation({
    mutationFn: convertEstimate,
    onSuccess: (inv) => {
      invalidate();
      toast.success(t('estimates.converted', 'Converted to invoice {{n}}', { n: inv.number }));
    },
    onError,
  });

  const openNew = () => {
    setForm({ ...EMPTY_FORM, items: [{ ...EMPTY_ITEM }] });
    setDialogOpen(true);
  };
  const openEdit = async (e: Estimate) => {
    // The list row omits items + notes, so fetch the full estimate and seed the
    // form from it — otherwise the editor opens with no line items and saving a
    // DRAFT would replace the estimate's items with an empty set (and wipe its
    // notes). Fall back to the list row only if the detail fetch fails.
    try {
      const full = await getEstimate(e.id);
      setForm(formFromEstimate(full));
    } catch {
      setForm(formFromEstimate(e));
    }
    setDialogOpen(true);
  };

  // Live money breakdown in MINOR units. Derives from the SAME normalized items
  // the save payload sends (computeFormTotals → normalizeEstimateItems), so the
  // preview can never disagree with the figure the server persists — in
  // particular, blank-description lines (dropped on save) no longer inflate it.
  const { formSubtotal, formTax, formTotal } = useMemo(() => {
    const { subtotal, tax, total } = computeFormTotals(form.items, pctOf);
    return { formSubtotal: subtotal, formTax: tax, formTotal: total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.items, taxRates]);

  const isDraft = !form.id || form.status === 'DRAFT';
  const rows = estimates ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('estimates.title', 'Estimates')}
        description={t('estimates.subtitle', 'Quotes you send to customers.')}
        actions={
          <Button size="md" onClick={openNew}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            {t('estimates.newEstimate', 'New estimate')}
          </Button>
        }
      />

      <QueryStateBoundary
        isLoading={isLoading}
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('common.loadError', 'Could not load. Please try again.')}
      >
        {rows.length === 0 ? (
          <EmptyState
            title={t('estimates.emptyTitle', 'No estimates yet')}
            description={t('estimates.empty', 'Create a quote and send it to a customer.')}
            action={
              <Button size="sm" onClick={openNew}>
                <Plus className="w-4 h-4" aria-hidden="true" />
                {t('estimates.newEstimate', 'New estimate')}
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            {rows.map((e) => (
              <Card key={e.id}>
                <CardContent className="p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-foreground">{e.number}</p>
                      <Badge tone={STATUS_TONE[e.status]} size="sm">
                        {t(`estimates.status.${e.status}`, e.status)}
                      </Badge>
                      {e.convertedInvoiceId && (
                        <Badge tone="success" size="sm">
                          {t('estimates.invoiced', 'Invoiced')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-lg font-semibold text-foreground mt-0.5">
                      {money(e.total, e.currency)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(e)} title={t('common.edit', 'Edit')}>
                      <Pencil className="w-4 h-4" aria-hidden="true" />
                    </Button>
                    {/* Each action's in-flight guard is scoped to THIS estimate
                        (mutation.variables === e.id) so a click can't double-fire
                        — important for Convert, which mints an invoice and whose
                        second request would otherwise surface a spurious error
                        toast after the first already succeeded. */}
                    {(e.status === 'DRAFT' || e.status === 'SENT') && (
                      <Button variant="ghost" size="sm" disabled={sendMut.isPending && sendMut.variables === e.id} onClick={() => sendMut.mutate(e.id)} title={t('estimates.send', 'Send')}>
                        <Send className="w-4 h-4" aria-hidden="true" />
                      </Button>
                    )}
                    {e.status !== 'ACCEPTED' && e.status !== 'DECLINED' && (
                      <>
                        <Button variant="ghost" size="sm" disabled={acceptMut.isPending && acceptMut.variables === e.id} onClick={() => acceptMut.mutate(e.id)} title={t('estimates.accept', 'Accept')}>
                          <Check className="w-4 h-4 text-success" aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="sm" disabled={declineMut.isPending && declineMut.variables === e.id} onClick={() => declineMut.mutate(e.id)} title={t('estimates.decline', 'Decline')}>
                          <X className="w-4 h-4 text-danger" aria-hidden="true" />
                        </Button>
                      </>
                    )}
                    {!e.convertedInvoiceId && (e.status === 'ACCEPTED' || e.status === 'SENT') && (
                      <Button variant="ghost" size="sm" disabled={convertMut.isPending && convertMut.variables === e.id} onClick={() => convertMut.mutate(e.id)} title={t('estimates.convert', 'Convert to invoice')}>
                        <FileOutput className="w-4 h-4 text-primary" aria-hidden="true" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" disabled={deleteMut.isPending && deleteMut.variables === e.id} onClick={() => deleteMut.mutate(e.id)}>
                      <Trash2 className="w-4 h-4 text-danger" aria-hidden="true" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </QueryStateBoundary>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {form.id ? t('estimates.editEstimate', 'Edit estimate') : t('estimates.newEstimate', 'New estimate')}
            </DialogTitle>
          </DialogHeader>

          {!isDraft && (
            <p className="text-caption text-muted-foreground">
              {t('estimates.readonlyNote', 'A sent estimate is read-only. Use the actions on the list.')}
            </p>
          )}

          <div className="space-y-3">
            {/* Quick-add from the products catalog */}
            {isDraft && products.length > 0 && (
              <Select value="" onValueChange={addProductLine}>
                <SelectTrigger>
                  <SelectValue placeholder={t('estimates.addFromProduct', 'Add from product…')} />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {Number(p.price)} {p.currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Line items */}
            <div className="space-y-2">
              {form.items.map((it, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Labeled label={i === 0 ? t('estimates.item', 'Item') : ''} className="basis-full sm:flex-1">
                    <Input
                      disabled={!isDraft}
                      value={it.description}
                      onChange={(e) =>
                        setForm((f) => {
                          const items = [...f.items];
                          items[i] = { ...items[i], description: e.target.value };
                          return { ...f, items };
                        })
                      }
                      placeholder={t('estimates.itemPlaceholder', 'Description')}
                    />
                  </Labeled>
                  <Labeled label={i === 0 ? t('estimates.qty', 'Qty') : ''} className="w-16">
                    <Input
                      type="number"
                      min={0}
                      disabled={!isDraft}
                      value={it.qty}
                      onChange={(e) =>
                        setForm((f) => {
                          const items = [...f.items];
                          items[i] = { ...items[i], qty: e.target.value };
                          return { ...f, items };
                        })
                      }
                    />
                  </Labeled>
                  <Labeled label={i === 0 ? t('estimates.unitPrice', 'Price') : ''} className="w-24">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      disabled={!isDraft}
                      value={it.price}
                      onChange={(e) =>
                        setForm((f) => {
                          const items = [...f.items];
                          items[i] = { ...items[i], price: e.target.value };
                          return { ...f, items };
                        })
                      }
                    />
                  </Labeled>
                  {taxRates.length > 0 && (
                    <Labeled label={i === 0 ? t('estimates.tax', 'Tax') : ''} className="w-28">
                      <Select
                        value={it.taxRateId ?? NO_TAX}
                        disabled={!isDraft}
                        onValueChange={(v) =>
                          setForm((f) => {
                            const items = [...f.items];
                            items[i] = { ...items[i], taxRateId: v === NO_TAX ? undefined : v };
                            return { ...f, items };
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t('estimates.tax', 'Tax')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_TAX}>{t('estimates.noTax', 'No tax')}</SelectItem>
                          {taxRates.map((r) => (
                            <SelectItem key={r.id} value={r.id}>
                              {r.name} (%{Number(r.rate)})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Labeled>
                  )}
                  {isDraft && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          items: f.items.length > 1 ? f.items.filter((_, j) => j !== i) : f.items,
                        }))
                      }
                    >
                      <Trash2 className="w-4 h-4 text-danger" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              ))}
              {isDraft && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setForm((f) => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))}
                >
                  <Plus className="w-4 h-4" aria-hidden="true" />
                  {t('estimates.addItem', 'Add item')}
                </Button>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="text-sm text-muted-foreground">{t('estimates.total', 'Total')}</span>
              <div className="text-right">
                {formTax > 0 && (
                  <p className="text-caption tabular-nums text-muted-foreground">
                    {t('estimates.subtotal', 'Subtotal')} {money(formSubtotal, form.currency)} ·{' '}
                    {t('estimates.tax', 'Tax')} {money(formTax, form.currency)}
                  </p>
                )}
                <span className="text-lg font-semibold text-foreground">
                  {money(formTotal, form.currency)}
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              <Labeled label={t('estimates.validUntil', 'Valid until')} className="flex-1">
                <Input
                  type="date"
                  disabled={!isDraft}
                  value={form.validUntil}
                  onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))}
                />
              </Labeled>
            </div>
            <Labeled label={t('estimates.notes', 'Notes')}>
              <Textarea
                rows={2}
                disabled={!isDraft}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </Labeled>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              {t('common.close', 'Close')}
            </Button>
            {isDraft && (
              <Button
                size="sm"
                disabled={saveMutation.isPending || !form.items.some((it) => it.description.trim())}
                onClick={() => saveMutation.mutate(form)}
              >
                {t('common.save', 'Save')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
