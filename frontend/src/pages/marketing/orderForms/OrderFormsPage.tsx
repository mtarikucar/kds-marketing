import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Trash2, Pencil, Link2, ShoppingCart } from 'lucide-react';

import {
  listOrderForms,
  getOrderForm,
  createOrderForm,
  updateOrderForm,
  deleteOrderForm,
  type OrderForm,
  type OrderFormDetail,
} from '../../../features/marketing/api/order-forms.service';
import { listProducts } from '../../../features/marketing/api/products.service';
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
  ConfirmDialog,
  Input,
  Switch,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui';

interface FormState {
  id?: string;
  name: string;
  productId: string;
  collectPhone: boolean;
  phoneRequired: boolean;
  active: boolean;
}
const EMPTY_FORM: FormState = {
  name: '',
  productId: '',
  collectPhone: true,
  phoneRequired: false,
  active: true,
};

/**
 * Map a full order-form record (the GET /:id detail) into the editor's form
 * state. The list endpoint omits `collectPhone`/`phoneRequired`, so the edit
 * dialog MUST build the form from the detail — the old code hardcoded those two
 * to their defaults, so editing a form (e.g. to rename it) silently reset its
 * phone settings on save.
 */
export function formFromOrderForm(f: OrderFormDetail): FormState {
  return {
    id: f.id,
    name: f.name,
    productId: f.productId ?? '',
    collectPhone: f.collectPhone ?? true,
    phoneRequired: f.phoneRequired ?? false,
    active: f.active,
  };
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

/**
 * Public payment-enabled Order Forms (GoHighLevel parity, MANAGER). Each form
 * sells a product via a shareable public link; a buyer's submission creates a
 * lead + invoice and sends them to pay. The public page is server-rendered at
 * /api/public/o/:token (no React route).
 */
export default function OrderFormsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState<OrderForm | null>(null);

  const { data: forms, isLoading } = useQuery({
    queryKey: ['marketing', 'order-forms'],
    queryFn: listOrderForms,
  });
  const { data: productPage } = useQuery({
    queryKey: ['marketing', 'products', 'active'],
    queryFn: () => listProducts({ active: true, limit: 100 }),
    staleTime: 60_000,
  });
  const products = productPage?.data ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'order-forms'] });
  const onError = (e: unknown) =>
    toast.error(
      (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        t('orderForms.saveError', 'Could not save'),
    );

  const saveMutation = useMutation({
    mutationFn: (f: FormState) => {
      const payload = {
        name: f.name.trim(),
        productId: f.productId || undefined,
        collectPhone: f.collectPhone,
        phoneRequired: f.phoneRequired,
        active: f.active,
      };
      return f.id ? updateOrderForm(f.id, payload) : createOrderForm(payload);
    },
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      toast.success(t('orderForms.saved', 'Saved'));
    },
    onError,
  });
  const deleteMut = useMutation({
    mutationFn: deleteOrderForm,
    onSuccess: () => { invalidate(); setDeleteTarget(null); toast.success(t('orderForms.deleted', 'Order form deleted')); },
    onError,
  });

  const copyLink = async (f: OrderForm) => {
    const url = `${window.location.origin}/api/public/o/${f.publicToken}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('orderForms.linkCopied', 'Public link copied'));
    } catch {
      toast.error(url);
    }
  };

  const openNew = () => {
    setForm({ ...EMPTY_FORM, productId: products[0]?.id ?? '' });
    setDialogOpen(true);
  };
  const openEdit = async (f: OrderForm) => {
    // The list row omits collectPhone/phoneRequired, so fetch the full record
    // and seed the form from it — otherwise the toggles open at their defaults
    // and saving would overwrite the form's real phone settings.
    try {
      const full = await getOrderForm(f.id);
      setForm(formFromOrderForm(full));
    } catch {
      setForm({
        id: f.id,
        name: f.name,
        productId: f.productId ?? '',
        collectPhone: true,
        phoneRequired: false,
        active: f.active,
      });
    }
    setDialogOpen(true);
  };

  const rows = forms ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('orderForms.title', 'Order forms')}
        description={t('orderForms.subtitle', 'Shareable links that sell a product and collect payment.')}
        actions={
          <Button size="md" onClick={openNew} disabled={products.length === 0}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            {t('orderForms.newForm', 'New order form')}
          </Button>
        }
      />

      {products.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">
          {t('orderForms.needProduct', 'Create a product first — order forms sell a product.')}
        </p>
      )}

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      )}

      {!isLoading && rows.length === 0 && products.length > 0 && (
        <EmptyState
          title={t('orderForms.emptyTitle', 'No order forms yet')}
          description={t('orderForms.empty', 'Create a shareable order form to sell a product online.')}
          action={
            <Button size="sm" onClick={openNew}>
              <Plus className="w-4 h-4" aria-hidden="true" />
              {t('orderForms.newForm', 'New order form')}
            </Button>
          }
        />
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((f) => {
            const product = products.find((p) => p.id === f.productId);
            return (
              <Card key={f.id} className={f.active ? '' : 'opacity-60'}>
                <CardContent className="p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <ShoppingCart className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
                      <p className="font-medium text-foreground truncate">{f.name}</p>
                      <Badge tone={f.active ? 'success' : 'neutral'} size="sm">
                        {f.active ? t('orderForms.active', 'Active') : t('orderForms.inactive', 'Inactive')}
                      </Badge>
                    </div>
                    {product && (
                      <p className="text-caption text-muted-foreground mt-0.5">
                        {product.name} · {Number(product.price)} {product.currency}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" onClick={() => copyLink(f)} title={t('orderForms.copyLink', 'Copy public link')}>
                      <Link2 className="w-4 h-4" aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(f)} title={t('common.edit', 'Edit')}>
                      <Pencil className="w-4 h-4" aria-hidden="true" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(f)} title={t('common.delete', 'Delete')}>
                      <Trash2 className="w-4 h-4 text-danger" aria-hidden="true" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {form.id ? t('orderForms.editForm', 'Edit order form') : t('orderForms.newForm', 'New order form')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Labeled label={t('orderForms.name', 'Name')}>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('orderForms.namePlaceholder', 'Pro plan signup')}
              />
            </Labeled>
            <Labeled label={t('orderForms.product', 'Product')}>
              <Select value={form.productId} onValueChange={(v) => setForm((f) => ({ ...f, productId: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder={t('orderForms.selectProduct', 'Select a product')} />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} · {Number(p.price)} {p.currency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Labeled>
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">{t('orderForms.collectPhone', 'Collect phone')}</span>
              <Switch checked={form.collectPhone} onCheckedChange={(v) => setForm((f) => ({ ...f, collectPhone: v }))} />
            </div>
            {form.collectPhone && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-foreground">{t('orderForms.phoneRequired', 'Phone required')}</span>
                <Switch checked={form.phoneRequired} onCheckedChange={(v) => setForm((f) => ({ ...f, phoneRequired: v }))} />
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">{t('orderForms.activeToggle', 'Active')}</span>
              <Switch checked={form.active} onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              disabled={saveMutation.isPending || !form.name.trim() || !form.productId}
              onClick={() => saveMutation.mutate(form)}
            >
              {t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('orderForms.deleteTitle', { defaultValue: 'Delete order form?' })}
        description={t('orderForms.deleteDesc', {
          defaultValue:
            'Its public link stops working immediately — anyone with the link can no longer order. This cannot be undone.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={deleteMut.isPending}
        onConfirm={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
      />
    </div>
  );
}
