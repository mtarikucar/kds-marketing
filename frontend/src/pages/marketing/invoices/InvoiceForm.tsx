/**
 * InvoiceForm — RHF+Zod form for creating a new invoice.
 * Extracted from InvoicesPage to keep the parent under ~300 lines.
 *
 * Mutation payload preserved verbatim:
 *   POST /invoices { currency, notes?, items: [{ description, qty, unitPrice (×100) }] }
 *   unitPrice = Math.round((Number(price) || 0) * 100)  ← financial math unchanged
 */
import { useState } from 'react';
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

interface Item { description: string; qty: number; price: string }

interface Props {
  isPending: boolean;
  onSubmit: (payload: {
    currency: string;
    notes?: string;
    items: { description: string; qty: number; unitPrice: number }[];
  }) => void;
  onCancel: () => void;
}

export function InvoiceForm({ isPending, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('marketing');

  const [currency, setCurrency] = useState('TRY');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<Item[]>([{ description: '', qty: 1, price: '' }]);

  // Live total (display only — unitPrice conversion happens in onSubmit)
  const total = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);

  const handleSubmit = () => {
    onSubmit({
      currency,
      notes: notes || undefined,
      items: items
        .filter((i) => i.description)
        .map((i) => ({
          description: i.description,
          qty: Number(i.qty) || 1,
          // Financial conversion — preserved verbatim from original InvoicesPage
          unitPrice: Math.round((Number(i.price) || 0) * 100),
        })),
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
                onChange={(e) => updateItem(idx, { qty: Number(e.target.value) })}
                placeholder="Qty"
              />
              <Input
                type="number"
                className="w-28"
                value={it.price}
                onChange={(e) => updateItem(idx, { price: e.target.value })}
                placeholder={t('invoices.unitPrice', 'Unit price')}
              />
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
          <p className="font-display text-h2 tabular-nums text-foreground">
            {total.toLocaleString()} {currency}
          </p>
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
