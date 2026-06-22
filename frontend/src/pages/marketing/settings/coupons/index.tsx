import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Ticket } from 'lucide-react';
import {
  listCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  type Coupon,
} from '../../../../features/marketing/api/coupons.service';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  Card,
  EmptyState,
  Skeleton,
  ConfirmDialog,
  Field,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui';

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  return Array.isArray(msg) ? msg[0] : (msg ?? fallback);
}

const schema = z.object({
  code: z.string().trim().min(1, 'required').max(40).regex(/^[A-Za-z0-9_-]+$/, 'code'),
  kind: z.enum(['PERCENT', 'FIXED']),
  // For PERCENT this is whole %, for FIXED it's the major-unit amount (×100 on submit).
  value: z.coerce.number().min(0.01),
  maxRedemptions: z.coerce.number().int().min(1).optional().or(z.literal('')),
  expiresAt: z.string().optional().or(z.literal('')),
  active: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

export default function CouponsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Coupon | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['marketing', 'coupons'], queryFn: listCoupons });
  const coupons: Coupon[] = Array.isArray(data) ? data : [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'coupons'] });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', kind: 'PERCENT', value: 10, maxRedemptions: '', expiresAt: '', active: true },
  });
  const kind = form.watch('kind');

  const openCreate = () => {
    setEditing(null);
    form.reset({ code: '', kind: 'PERCENT', value: 10, maxRedemptions: '', expiresAt: '', active: true });
    setOpen(true);
  };
  const openEdit = (c: Coupon) => {
    setEditing(c);
    form.reset({
      code: c.code,
      kind: c.kind,
      value: c.kind === 'FIXED' ? c.value / 100 : c.value,
      maxRedemptions: c.maxRedemptions ?? '',
      expiresAt: c.expiresAt ? c.expiresAt.slice(0, 10) : '',
      active: c.active,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const payload = {
        code: v.code,
        kind: v.kind,
        // FIXED is stored in minor units; PERCENT is a whole percent.
        value: v.kind === 'FIXED' ? Math.round(Number(v.value) * 100) : Math.round(Number(v.value)),
        maxRedemptions: v.maxRedemptions ? Number(v.maxRedemptions) : undefined,
        expiresAt: v.expiresAt || undefined,
        active: v.active,
      };
      return editing ? updateCoupon(editing.id, payload) : createCoupon(payload);
    },
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setEditing(null);
      toast.success(t('coupons.toast.saved', { defaultValue: 'Coupon saved' }));
    },
    onError: (e) => toast.error(apiError(e, t('coupons.toast.failed', { defaultValue: 'Failed to save' }))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteCoupon(id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('coupons.toast.deleted', { defaultValue: 'Coupon deleted' }));
    },
    onError: (e) => toast.error(apiError(e, t('coupons.toast.failed', { defaultValue: 'Failed' }))),
  });

  const fieldErr = (m?: string) => (m ? t([`validation.${m}`, m], { defaultValue: m }) : undefined);
  const errors = form.formState.errors;
  const handleSubmit: SubmitHandler<FormValues> = (v) => save.mutate(v);

  const valueLabel = (c: Coupon) => (c.kind === 'PERCENT' ? `%${c.value}` : `${(c.value / 100).toLocaleString()} ${c.currency ?? ''}`);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('coupons.title', { defaultValue: 'Coupons' })}
        description={t('coupons.subtitle', { defaultValue: 'Discount codes applied at checkout on order forms and invoices.' })}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('coupons.new', { defaultValue: 'New coupon' })}
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-32" />
      ) : coupons.length === 0 ? (
        <EmptyState
          icon={<Ticket className="h-10 w-10" />}
          title={t('coupons.empty.title', { defaultValue: 'No coupons yet' })}
          description={t('coupons.empty.description', { defaultValue: 'Create a discount code to drive conversions.' })}
          action={
            <Button onClick={openCreate} variant="outline">
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('coupons.new', { defaultValue: 'New coupon' })}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {coupons.map((c) => (
            <Card key={c.id} className="flex items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-semibold text-foreground">
                  {c.code}
                  {!c.active && <Badge tone="neutral" size="sm" className="ml-2">{t('coupons.inactive', { defaultValue: 'Inactive' })}</Badge>}
                </p>
                <p className="text-xl font-semibold tabular-nums text-primary">−{valueLabel(c)}</p>
                <p className="text-micro text-muted-foreground">
                  {c.timesRedeemed}
                  {c.maxRedemptions ? `/${c.maxRedemptions}` : ''} {t('coupons.used', { defaultValue: 'used' })}
                  {c.expiresAt ? ` · ${t('coupons.expires', { defaultValue: 'exp' })} ${c.expiresAt.slice(0, 10)}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <IconButton variant="ghost" size="sm" aria-label={t('common.edit', { defaultValue: 'Edit' })} onClick={() => openEdit(c)}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton variant="ghost" size="sm" aria-label={t('common.delete', { defaultValue: 'Delete' })} onClick={() => setDeleteTarget(c)}>
                  <Trash2 className="h-4 w-4 text-danger" aria-hidden="true" />
                </IconButton>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? t('coupons.form.editTitle', { defaultValue: 'Edit coupon' }) : t('coupons.form.newTitle', { defaultValue: 'New coupon' })}</DialogTitle>
            <DialogDescription>{t('coupons.form.subtitle', { defaultValue: 'The discount amount is resolved server-side at checkout.' })}</DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <Field label={t('coupons.form.code', { defaultValue: 'Code' })} error={fieldErr(errors.code?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="SAVE10" disabled={!!editing} {...form.register('code')} />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('coupons.form.kind', { defaultValue: 'Type' })}>
                {({ id }) => (
                  <Controller
                    control={form.control}
                    name="kind"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="PERCENT">{t('coupons.percent', { defaultValue: 'Percent (%)' })}</SelectItem>
                          <SelectItem value="FIXED">{t('coupons.fixed', { defaultValue: 'Fixed amount' })}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>
              <Field label={kind === 'PERCENT' ? t('coupons.form.percentValue', { defaultValue: 'Value (%)' }) : t('coupons.form.fixedValue', { defaultValue: 'Amount' })} error={fieldErr(errors.value?.message)} required>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} type="number" step="0.01" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('value')} />
                )}
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('coupons.form.maxRedemptions', { defaultValue: 'Max uses (optional)' })} error={fieldErr(errors.maxRedemptions?.message as string)}>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} type="number" min={1} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('maxRedemptions')} />
                )}
              </Field>
              <Field label={t('coupons.form.expiresAt', { defaultValue: 'Expires (optional)' })}>
                {({ id, describedBy, invalid }) => (
                  <Input id={id} type="date" aria-describedby={describedBy} aria-invalid={invalid} {...form.register('expiresAt')} />
                )}
              </Field>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
              <Button type="submit" loading={save.isPending}>{t('common.save', { defaultValue: 'Save' })}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('coupons.confirm.deleteTitle', { defaultValue: 'Delete coupon' })}
        description={t('coupons.confirm.deleteBody', { defaultValue: 'The code stops working immediately.' })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        loading={remove.isPending}
      />
    </div>
  );
}
