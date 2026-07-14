/**
 * InvoiceForm — RHF+Zod form for creating a new invoice.
 * Extracted from InvoicesPage to keep the parent under ~300 lines.
 *
 * Mutation payload preserved verbatim:
 *   POST /invoices { currency, notes?, items: [{ description, qty, unitPrice (×100) }] }
 *   unitPrice = Math.round((Number(price) || 0) * 100)  ← financial math unchanged
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/Card';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/Select';
import { listTaxRates } from '../../../features/marketing/api/tax-rates.service';

interface Item { description: string; qty: number; price: string; taxRateId?: string }

const NO_TAX = '__none__';

interface Props {
  isPending: boolean;
  onSubmit: (payload: {
    currency: string;
    notes?: string;
    items: { description: string; qty: number; unitPrice: number; taxRateId?: string }[];
  }) => void;
  onCancel: () => void;
}

/**
 * The exact line items the invoice will PERSIST: description-less rows are
 * dropped, qty defaults to 1 (the input's min, and what gets billed), and price
 * is converted to minor units. Both the POST payload AND the live total preview
 * derive from this, so the editor can never show a figure different from what
 * the server bills.
 */
export function normalizeInvoiceItems(
  items: Item[],
): { description: string; qty: number; unitPrice: number; taxRateId?: string }[] {
  return items
    .filter((i) => i.description)
    .map((i) => ({
      description: i.description,
      // Backend InvoiceItemDto is @IsInt @Min(0) @Max(1_000_000) on qty AND
      // unitPrice (kuruş) — coerce to an integer in range so the previewed total
      // always matches a payload the server accepts (a fractional/over-max line
      // otherwise quoted a figure the POST then rejected with a cryptic 400).
      qty: Math.min(1_000_000, Math.max(0, Math.round(Number(i.qty) || 1))),
      unitPrice: Math.min(1_000_000, Math.max(0, Math.round((Number(i.price) || 0) * 100))),
      ...(i.taxRateId ? { taxRateId: i.taxRateId } : {}),
    }));
}

/**
 * Minor-unit subtotal / tax / total over the PERSISTED items — exclusive tax,
 * rounded per line then summed, mirroring the backend computeMoneyTotals.
 */
export function computeInvoiceTotals(
  items: Item[],
  pctOf: (taxRateId?: string) => number,
): { subtotal: number; tax: number; total: number } {
  let subtotal = 0;
  let tax = 0;
  for (const it of normalizeInvoiceItems(items)) {
    const line = it.qty * it.unitPrice;
    subtotal += line;
    tax += Math.round((line * pctOf(it.taxRateId)) / 100);
  }
  return { subtotal, tax, total: subtotal + tax };
}

export function InvoiceForm({ isPending, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('marketing');

  const [currency, setCurrency] = useState('TRY');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<Item[]>([{ description: '', qty: 1, price: '' }]);

  const { data: taxRates = [] } = useQuery({ queryKey: ['marketing', 'tax-rates'], queryFn: listTaxRates });
  const pctOf = (taxRateId?: string) => Number(taxRates.find((r) => r.id === taxRateId)?.rate ?? 0);

  // Live breakdown in MINOR units, derived from the SAME normalized rows the
  // payload sends — so the preview can't disagree with what gets billed (in
  // particular, blank-description lines and a cleared qty no longer diverge).
  const { subtotal, tax, total } = computeInvoiceTotals(items, pctOf);

  const handleSubmit = () => {
    onSubmit({
      currency,
      notes: notes || undefined,
      items: normalizeInvoiceItems(items),
    });
  };

  const updateItem = (idx: number, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('invoices.newTitle', 'New invoice')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Line items */}
        <div className="space-y-2">
          {items.map((it, idx) => (
            <div key={idx} className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-0 flex-1"
                value={it.description}
                onChange={(e) => updateItem(idx, { description: e.target.value })}
                placeholder={t('invoices.itemDesc', 'Description')}
              />
              <Input
                type="number"
                className="w-20"
                value={it.qty}
                min={1}
                max={1000000}
                step={1}
                onChange={(e) => updateItem(idx, { qty: Number(e.target.value) })}
                placeholder="Qty"
              />
              <Input
                type="number"
                className="w-28"
                value={it.price}
                min={0}
                max={10000}
                step="0.01"
                onChange={(e) => updateItem(idx, { price: e.target.value })}
                placeholder={t('invoices.unitPrice', 'Unit price')}
              />
              {taxRates.length > 0 && (
                <Select
                  value={it.taxRateId ?? NO_TAX}
                  onValueChange={(v) => updateItem(idx, { taxRateId: v === NO_TAX ? undefined : v })}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue placeholder={t('invoices.tax', 'Tax')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TAX}>{t('invoices.noTax', 'No tax')}</SelectItem>
                    {taxRates.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name} (%{Number(r.rate)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <button
                type="button"
                onClick={() => setItems((prev) => prev.filter((_, j) => j !== idx))}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-danger hover:bg-danger-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('common.remove', 'Remove')}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setItems((prev) => [...prev, { description: '', qty: 1, price: '' }])}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t('invoices.addItem', 'Add line')}
          </Button>
        </div>

        {/* Currency + notes + total */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-32">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t('invoices.currency', 'Currency')}
            </p>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TRY">TRY</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
                <SelectItem value="EUR">EUR</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t('invoices.notes', 'Notes')}
            </p>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('invoices.notesPlaceholder', 'Optional notes…')}
            />
          </div>
          <div className="text-right">
            {tax > 0 && (
              <p className="text-xs tabular-nums text-muted-foreground">
                {t('invoices.subtotal', 'Subtotal')} {(subtotal / 100).toLocaleString()} · {t('invoices.tax', 'Tax')} {(tax / 100).toLocaleString()}
              </p>
            )}
            <p className="font-display text-h2 tabular-nums text-foreground">
              {(total / 100).toLocaleString()} {currency}
            </p>
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button
          loading={isPending}
          disabled={isPending || !items.some((i) => i.description)}
          onClick={handleSubmit}
        >
          {t('invoices.createBtn', 'Create')}
        </Button>
      </CardFooter>
    </Card>
  );
}
