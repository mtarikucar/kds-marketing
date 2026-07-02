import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Archive, Trash2, Package } from 'lucide-react';

import {
  listProducts,
  createProduct,
  updateProduct,
  archiveProduct,
  deleteProduct,
  type Product,
} from '../../../features/marketing/api/products.service';
import {
  PageHeader,
  Button,
  Card,
  CardContent,
  Badge,
  Spinner,
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
  ConfirmDialog,
} from '@/components/ui';

/** Surface the API's own message (e.g. the product-delete 409) when present. */
function errMessage(e: unknown, fallback: string): string {
  const m = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(m)) return String(m[0]);
  return typeof m === 'string' ? m : fallback;
}

const CURRENCIES = ['TRY', 'USD', 'EUR'] as const;

function money(value: string | number, currency: string): string {
  const n = typeof value === 'string' ? Number(value) : value;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      Number.isFinite(n) ? n : 0,
    );
  } catch {
    return `${n} ${currency}`;
  }
}

interface FormState {
  id?: string;
  name: string;
  description: string;
  sku: string;
  price: string;
  currency: string;
  billingType: 'ONE_TIME' | 'RECURRING';
  interval: 'MONTH' | 'YEAR';
  taxRate: string;
}

const EMPTY: FormState = {
  name: '',
  description: '',
  sku: '',
  price: '',
  currency: 'TRY',
  billingType: 'ONE_TIME',
  interval: 'MONTH',
  taxRate: '',
};

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
 * Products catalog (GoHighLevel parity, MANAGER). Reusable priced items the
 * workspace sells. Create/edit one-time or recurring products, archive (soft
 * retire) or delete. Backend enforces leads.manage; the route is manager-gated.
 */
export default function ProductsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['marketing', 'products'],
    queryFn: () => listProducts({ limit: 100 }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'products'] });
  const onError = () => toast.error(t('products.saveError', 'Could not save the product'));

  const saveMutation = useMutation({
    mutationFn: (f: FormState) => {
      const payload = {
        name: f.name.trim(),
        // Clearing a text field must PERSIST on edit: send '' so the PATCH
        // actually blanks it. Sending undefined is skipped by the backend's
        // Prisma merge, so the OLD value silently survives ("I removed the SKU
        // but it came back"). A create can leave an empty field absent (the
        // backend defaults it to null). Backend DTO allows '' (no @IsNotEmpty).
        description: f.id ? f.description.trim() : (f.description.trim() || undefined),
        sku: f.id ? f.sku.trim() : (f.sku.trim() || undefined),
        price: f.price === '' ? undefined : Number(f.price),
        currency: f.currency,
        billingType: f.billingType,
        interval: f.billingType === 'RECURRING' ? f.interval : undefined,
        taxRate: f.taxRate === '' ? undefined : Number(f.taxRate),
      };
      return f.id ? updateProduct(f.id, payload) : createProduct(payload);
    },
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setForm(EMPTY);
      toast.success(t('products.saved', 'Saved'));
    },
    onError,
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveProduct(id),
    onSuccess: () => {
      invalidate();
      toast.success(t('products.archived', 'Product archived'));
    },
    onError,
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProduct(id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('products.deleted', 'Product deleted'));
    },
    // Surface the API's reason verbatim — a referenced product can't be deleted
    // (it would break a public order form) and the 409 says to archive instead.
    onError: (e) =>
      toast.error(errMessage(e, t('products.deleteError', 'Could not delete this product'))),
  });

  const openNew = () => {
    setForm(EMPTY);
    setDialogOpen(true);
  };
  const openEdit = (p: Product) => {
    setForm({
      id: p.id,
      name: p.name,
      description: p.description ?? '',
      sku: p.sku ?? '',
      price: String(p.price ?? ''),
      currency: p.currency,
      billingType: p.billingType,
      interval: p.interval ?? 'MONTH',
      taxRate: p.taxRate == null ? '' : String(p.taxRate),
    });
    setDialogOpen(true);
  };

  const products = data?.data ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('products.title', 'Products')}
        description={t('products.subtitle', 'Reusable priced items you sell.')}
        actions={
          <Button size="md" onClick={openNew}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            {t('products.newProduct', 'New product')}
          </Button>
        }
      />

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      )}

      {!isLoading && products.length === 0 && (
        <EmptyState
          title={t('products.emptyTitle', 'No products yet')}
          description={t('products.empty', 'Create products to reuse on invoices and deals.')}
          action={
            <Button size="sm" onClick={openNew}>
              <Plus className="w-4 h-4" aria-hidden="true" />
              {t('products.newProduct', 'New product')}
            </Button>
          }
        />
      )}

      {products.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <Card key={p.id} className={p.active ? '' : 'opacity-60'}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Package className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
                    <p className="font-medium text-foreground truncate">{p.name}</p>
                  </div>
                  <Badge tone={p.billingType === 'RECURRING' ? 'info' : 'neutral'} size="sm">
                    {p.billingType === 'RECURRING'
                      ? t(`products.interval.${p.interval}`, p.interval ?? '')
                      : t('products.oneTime', 'One-time')}
                  </Badge>
                </div>
                <p className="text-lg font-semibold text-foreground">
                  {money(p.price, p.currency)}
                  {p.taxRate != null && Number(p.taxRate) > 0 && (
                    <span className="text-caption text-muted-foreground ml-1">
                      +{Number(p.taxRate)}% {t('products.tax', 'tax')}
                    </span>
                  )}
                </p>
                {p.description && (
                  <p className="text-caption text-muted-foreground line-clamp-2">{p.description}</p>
                )}
                <div className="flex items-center gap-1 pt-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('products.edit', 'Edit product')}
                    onClick={() => openEdit(p)}
                  >
                    <Pencil className="w-4 h-4" aria-hidden="true" />
                  </Button>
                  {p.active && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('products.archive', 'Archive product')}
                      onClick={() => archiveMutation.mutate(p.id)}
                    >
                      <Archive className="w-4 h-4" aria-hidden="true" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('products.delete', 'Delete product')}
                    onClick={() => setDeleteTarget(p)}
                  >
                    <Trash2 className="w-4 h-4 text-danger" aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {form.id ? t('products.editProduct', 'Edit product') : t('products.newProduct', 'New product')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Labeled label={t('products.name', 'Name')}>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('products.namePlaceholder', 'Pro plan')}
              />
            </Labeled>
            <div className="flex gap-2">
              <Labeled label={t('products.price', 'Price')} className="flex-1">
                <Input
                  type="number"
                  min={0}
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                />
              </Labeled>
              <Labeled label={t('products.currency', 'Currency')} className="w-28">
                <Select value={form.currency} onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Labeled>
            </div>
            <div className="flex gap-2">
              <Labeled label={t('products.billingType', 'Billing')} className="flex-1">
                <Select
                  value={form.billingType}
                  onValueChange={(v) => setForm((f) => ({ ...f, billingType: v as FormState['billingType'] }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ONE_TIME">{t('products.oneTime', 'One-time')}</SelectItem>
                    <SelectItem value="RECURRING">{t('products.recurring', 'Recurring')}</SelectItem>
                  </SelectContent>
                </Select>
              </Labeled>
              {form.billingType === 'RECURRING' && (
                <Labeled label={t('products.intervalLabel', 'Interval')} className="flex-1">
                  <Select
                    value={form.interval}
                    onValueChange={(v) => setForm((f) => ({ ...f, interval: v as FormState['interval'] }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MONTH">{t('products.interval.MONTH', 'Monthly')}</SelectItem>
                      <SelectItem value="YEAR">{t('products.interval.YEAR', 'Yearly')}</SelectItem>
                    </SelectContent>
                  </Select>
                </Labeled>
              )}
              <Labeled label={t('products.tax', 'Tax %')} className="w-24">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={form.taxRate}
                  onChange={(e) => setForm((f) => ({ ...f, taxRate: e.target.value }))}
                />
              </Labeled>
            </div>
            <Labeled label={t('products.sku', 'SKU')}>
              <Input value={form.sku} onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))} />
            </Labeled>
            <Labeled label={t('products.description', 'Description')}>
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </Labeled>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              disabled={!form.name.trim() || saveMutation.isPending}
              onClick={() => saveMutation.mutate(form)}
            >
              {t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={t('products.deleteTitle', 'Delete product')}
        description={t(
          'products.deleteDesc',
          'This permanently deletes the product. A product used by an order form cannot be deleted — archive it instead to keep that checkout working.',
        )}
        confirmLabel={t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
      />
    </div>
  );
}
