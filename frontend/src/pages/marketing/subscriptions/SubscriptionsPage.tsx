import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Trash2, Pause, Play, Ban, Pencil, Repeat } from 'lucide-react';

import {
  listSubscriptions,
  createSubscription,
  updateSubscription,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  type Subscription,
  type SubscriptionStatus,
} from '../../../features/marketing/api/subscriptions.service';
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
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui';

const STATUS_TONE: Record<SubscriptionStatus, 'success' | 'warning' | 'neutral'> = {
  ACTIVE: 'success',
  PAUSED: 'warning',
  CANCELLED: 'neutral',
};

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      (minor || 0) / 100,
    );
  } catch {
    return `${(minor || 0) / 100} ${currency}`;
  }
}

interface ItemRow {
  description: string;
  qty: string;
  price: string; // major units; ×100 on save
}

interface FormState {
  id?: string;
  status?: SubscriptionStatus;
  name: string;
  currency: string;
  interval: 'MONTH' | 'YEAR' | 'WEEK';
  intervalCount: string;
  dueDays: string;
  items: ItemRow[];
}

const EMPTY_ITEM: ItemRow = { description: '', qty: '1', price: '' };
const EMPTY_FORM: FormState = {
  name: '',
  currency: 'TRY',
  interval: 'MONTH',
  intervalCount: '1',
  dueDays: '14',
  items: [{ ...EMPTY_ITEM }],
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
 * Recurring customer subscriptions (GoHighLevel parity, MANAGER). Each active
 * subscription generates a DRAFT invoice every billing period (server cron). The
 * workspace then collects via the normal invoice flow. Create/edit a plan with a
 * line-item editor + cadence, and pause/resume/cancel.
 */
export default function SubscriptionsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const { data: subs, isLoading } = useQuery({
    queryKey: ['marketing', 'subscriptions'],
    queryFn: listSubscriptions,
  });
  const { data: productPage } = useQuery({
    queryKey: ['marketing', 'products', 'active'],
    queryFn: () => listProducts({ active: true, limit: 100 }),
    staleTime: 60_000,
  });
  const products = productPage?.data ?? [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'subscriptions'] });
  const onError = (e: unknown) =>
    toast.error(
      (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        t('subscriptions.saveError', 'Could not save'),
    );

  const buildPayload = (f: FormState) => ({
    name: f.name.trim(),
    currency: f.currency,
    interval: f.interval,
    intervalCount: Math.max(1, Math.round(Number(f.intervalCount) || 1)),
    dueDays: Math.max(0, Math.round(Number(f.dueDays) || 0)),
    items: f.items
      .filter((it) => it.description.trim())
      .map((it) => ({
        description: it.description.trim(),
        qty: Math.max(0, Math.round(Number(it.qty) || 0)),
        unitPrice: Math.max(0, Math.round(Number(it.price) * 100 || 0)),
      })),
  });

  const saveMutation = useMutation({
    mutationFn: (f: FormState) =>
      f.id ? updateSubscription(f.id, buildPayload(f)) : createSubscription(buildPayload(f)),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      toast.success(t('subscriptions.saved', 'Saved'));
    },
    onError,
  });
  const pauseMut = useMutation({ mutationFn: pauseSubscription, onSuccess: () => { invalidate(); toast.success(t('subscriptions.paused', 'Paused')); }, onError });
  const resumeMut = useMutation({ mutationFn: resumeSubscription, onSuccess: () => { invalidate(); toast.success(t('subscriptions.resumed', 'Resumed')); }, onError });
  const cancelMut = useMutation({ mutationFn: cancelSubscription, onSuccess: () => { invalidate(); toast.success(t('subscriptions.cancelled', 'Cancelled')); }, onError });

  const openNew = () => {
    setForm({ ...EMPTY_FORM, items: [{ ...EMPTY_ITEM }] });
    setDialogOpen(true);
  };
  const openEdit = (s: Subscription) => {
    setForm({
      id: s.id,
      status: s.status,
      name: s.name,
      currency: s.currency,
      interval: s.interval,
      intervalCount: String(s.intervalCount),
      dueDays: '14',
      // List endpoint omits items; editing replaces them (a draft of one row to start).
      items: [{ ...EMPTY_ITEM }],
    });
    setDialogOpen(true);
  };

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

  const formTotal = useMemo(
    () =>
      form.items.reduce(
        (s, it) => s + Math.round(Number(it.qty) || 0) * Math.round(Number(it.price) * 100 || 0),
        0,
      ),
    [form.items],
  );

  const cadence = (s: Subscription) =>
    s.intervalCount > 1
      ? t('subscriptions.everyN', 'Every {{n}} {{unit}}', {
          n: s.intervalCount,
          unit: t(`subscriptions.intervalUnit.${s.interval}`, s.interval),
        })
      : t(`subscriptions.intervalEvery.${s.interval}`, s.interval);

  const rows = subs ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('subscriptions.title', 'Subscriptions')}
        description={t('subscriptions.subtitle', 'Recurring plans that auto-generate invoices each period.')}
        actions={
          <Button size="md" onClick={openNew}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            {t('subscriptions.newPlan', 'New subscription')}
          </Button>
        }
      />

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <EmptyState
          title={t('subscriptions.emptyTitle', 'No subscriptions yet')}
          description={t('subscriptions.empty', 'Create a recurring plan to auto-bill a customer each period.')}
          action={
            <Button size="sm" onClick={openNew}>
              <Plus className="w-4 h-4" aria-hidden="true" />
              {t('subscriptions.newPlan', 'New subscription')}
            </Button>
          }
        />
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((s) => (
            <Card key={s.id} className={s.status === 'CANCELLED' ? 'opacity-60' : ''}>
              <CardContent className="p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Repeat className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
                    <p className="font-medium text-foreground truncate">{s.name}</p>
                    <Badge tone={STATUS_TONE[s.status]} size="sm">
                      {t(`subscriptions.status.${s.status}`, s.status)}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {money(s.amount, s.currency)} · {cadence(s)}
                    {s.status === 'ACTIVE' && (
                      <>
                        {' · '}
                        {t('subscriptions.next', 'next')}{' '}
                        {new Date(s.nextBillingAt).toLocaleDateString()}
                      </>
                    )}
                    {s.invoicesGenerated > 0 && (
                      <> · {t('subscriptions.invoiced', '{{n}} invoiced', { n: s.invoicesGenerated })}</>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(s)} title={t('common.edit', 'Edit')}>
                    <Pencil className="w-4 h-4" aria-hidden="true" />
                  </Button>
                  {s.status === 'ACTIVE' && (
                    <Button variant="ghost" size="sm" onClick={() => pauseMut.mutate(s.id)} title={t('subscriptions.pause', 'Pause')}>
                      <Pause className="w-4 h-4" aria-hidden="true" />
                    </Button>
                  )}
                  {s.status === 'PAUSED' && (
                    <Button variant="ghost" size="sm" onClick={() => resumeMut.mutate(s.id)} title={t('subscriptions.resume', 'Resume')}>
                      <Play className="w-4 h-4 text-success" aria-hidden="true" />
                    </Button>
                  )}
                  {s.status !== 'CANCELLED' && (
                    <Button variant="ghost" size="sm" onClick={() => cancelMut.mutate(s.id)} title={t('subscriptions.cancel', 'Cancel')}>
                      <Ban className="w-4 h-4 text-danger" aria-hidden="true" />
                    </Button>
                  )}
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
              {form.id ? t('subscriptions.editPlan', 'Edit subscription') : t('subscriptions.newPlan', 'New subscription')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Labeled label={t('subscriptions.name', 'Name')}>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('subscriptions.namePlaceholder', 'Gold membership')}
              />
            </Labeled>

            <div className="flex gap-2">
              <Labeled label={t('subscriptions.interval', 'Billing every')} className="flex-1">
                <Select value={form.interval} onValueChange={(v) => setForm((f) => ({ ...f, interval: v as FormState['interval'] }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WEEK">{t('subscriptions.intervalUnit.WEEK', 'week(s)')}</SelectItem>
                    <SelectItem value="MONTH">{t('subscriptions.intervalUnit.MONTH', 'month(s)')}</SelectItem>
                    <SelectItem value="YEAR">{t('subscriptions.intervalUnit.YEAR', 'year(s)')}</SelectItem>
                  </SelectContent>
                </Select>
              </Labeled>
              <Labeled label={t('subscriptions.intervalCount', 'Count')} className="w-20">
                <Input type="number" min={1} max={60} value={form.intervalCount} onChange={(e) => setForm((f) => ({ ...f, intervalCount: e.target.value }))} />
              </Labeled>
              <Labeled label={t('subscriptions.dueDays', 'Due (days)')} className="w-24">
                <Input type="number" min={0} max={365} value={form.dueDays} onChange={(e) => setForm((f) => ({ ...f, dueDays: e.target.value }))} />
              </Labeled>
            </div>

            {products.length > 0 && (
              <Select value="" onValueChange={addProductLine}>
                <SelectTrigger>
                  <SelectValue placeholder={t('subscriptions.addFromProduct', 'Add from product…')} />
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

            <div className="space-y-2">
              {form.items.map((it, i) => (
                <div key={i} className="flex items-end gap-2">
                  <Labeled label={i === 0 ? t('subscriptions.item', 'Item') : ''} className="flex-1">
                    <Input
                      value={it.description}
                      onChange={(e) => setForm((f) => { const items = [...f.items]; items[i] = { ...items[i], description: e.target.value }; return { ...f, items }; })}
                      placeholder={t('subscriptions.itemPlaceholder', 'Description')}
                    />
                  </Labeled>
                  <Labeled label={i === 0 ? t('subscriptions.qty', 'Qty') : ''} className="w-16">
                    <Input type="number" min={0} value={it.qty}
                      onChange={(e) => setForm((f) => { const items = [...f.items]; items[i] = { ...items[i], qty: e.target.value }; return { ...f, items }; })} />
                  </Labeled>
                  <Labeled label={i === 0 ? t('subscriptions.unitPrice', 'Price') : ''} className="w-24">
                    <Input type="number" min={0} step="0.01" value={it.price}
                      onChange={(e) => setForm((f) => { const items = [...f.items]; items[i] = { ...items[i], price: e.target.value }; return { ...f, items }; })} />
                  </Labeled>
                  <Button variant="ghost" size="sm"
                    onClick={() => setForm((f) => ({ ...f, items: f.items.length > 1 ? f.items.filter((_, j) => j !== i) : f.items }))}>
                    <Trash2 className="w-4 h-4 text-danger" aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setForm((f) => ({ ...f, items: [...f.items, { ...EMPTY_ITEM }] }))}>
                <Plus className="w-4 h-4" aria-hidden="true" />
                {t('subscriptions.addItem', 'Add item')}
              </Button>
            </div>

            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="text-sm text-muted-foreground">{t('subscriptions.perPeriod', 'Per period')}</span>
              <span className="text-lg font-semibold text-foreground">{money(formTotal, form.currency)}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button size="sm"
              disabled={saveMutation.isPending || !form.name.trim() || !form.items.some((it) => it.description.trim())}
              onClick={() => saveMutation.mutate(form)}>
              {t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
