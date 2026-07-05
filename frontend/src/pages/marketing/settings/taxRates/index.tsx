import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Archive, Percent } from 'lucide-react';
import {
  listTaxRates,
  createTaxRate,
  updateTaxRate,
  deleteTaxRate,
  type TaxRate,
} from '../../../../features/marketing/api/tax-rates.service';
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
  Switch,
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
  name: z.string().trim().min(1, 'required').max(80),
  rate: z.coerce.number().min(0).max(100),
  isDefault: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

export default function TaxRatesPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TaxRate | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<TaxRate | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['marketing', 'tax-rates'], queryFn: listTaxRates });
  const rates: TaxRate[] = Array.isArray(data) ? data : [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'tax-rates'] });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', rate: 20, isDefault: false },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ name: '', rate: 20, isDefault: false });
    setOpen(true);
  };
  const openEdit = (r: TaxRate) => {
    setEditing(r);
    form.reset({ name: r.name, rate: Number(r.rate), isDefault: r.isDefault });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      editing ? updateTaxRate(editing.id, v) : createTaxRate(v),
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setEditing(null);
      toast.success(t('taxRates.toast.saved', { defaultValue: 'Tax rate saved' }));
    },
    onError: (e) => toast.error(apiError(e, t('taxRates.toast.failed', { defaultValue: 'Failed to save' }))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteTaxRate(id),
    onSuccess: () => {
      invalidate();
      setArchiveTarget(null);
      toast.success(t('taxRates.toast.archived', { defaultValue: 'Tax rate archived' }));
    },
    onError: (e) => toast.error(apiError(e, t('taxRates.toast.failed', { defaultValue: 'Failed' }))),
  });

  const fieldErr = (m?: string) => (m ? t([`validation.${m}`, m], { defaultValue: m }) : undefined);
  const errors = form.formState.errors;
  const handleSubmit: SubmitHandler<FormValues> = (v) => save.mutate(v);

  return (
    <div className="space-y-5">
      {!embedded ? (
        <PageHeader
          title={t('taxRates.title', { defaultValue: 'Tax Rates' })}
          description={t('taxRates.subtitle', {
            defaultValue: 'Reusable rates (e.g. KDV %20) applied to invoice and estimate lines.',
          })}
          actions={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('taxRates.new', { defaultValue: 'New rate' })}
            </Button>
          }
        />
      ) : (
        // Embedded (Products tab): the host owns the page header, but the
        // primary action must stay reachable — keep it as a small toolbar row.
        <div className="flex justify-end">
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('taxRates.new', { defaultValue: 'New rate' })}
          </Button>
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-32" />
      ) : rates.length === 0 ? (
        <EmptyState
          icon={<Percent className="h-10 w-10" />}
          title={t('taxRates.empty.title', { defaultValue: 'No tax rates yet' })}
          description={t('taxRates.empty.description', { defaultValue: 'Add a rate to apply tax to invoices and estimates.' })}
          action={
            <Button onClick={openCreate} variant="outline">
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('taxRates.new', { defaultValue: 'New rate' })}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rates.map((r) => (
            <Card key={r.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {r.name}
                  {r.isDefault && (
                    <Badge tone="success" size="sm" className="ml-2">
                      {t('taxRates.default', { defaultValue: 'Default' })}
                    </Badge>
                  )}
                </p>
                <p className="text-2xl font-semibold tabular-nums text-primary">%{Number(r.rate)}</p>
              </div>
              <div className="flex items-center gap-1">
                <IconButton variant="ghost" size="sm" aria-label={t('common.edit', { defaultValue: 'Edit' })} onClick={() => openEdit(r)}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton variant="ghost" size="sm" aria-label={t('taxRates.archive', { defaultValue: 'Archive' })} onClick={() => setArchiveTarget(r)}>
                  <Archive className="h-4 w-4 text-danger" aria-hidden="true" />
                </IconButton>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('taxRates.form.editTitle', { defaultValue: 'Edit tax rate' }) : t('taxRates.form.newTitle', { defaultValue: 'New tax rate' })}
            </DialogTitle>
            <DialogDescription>
              {t('taxRates.form.subtitle', { defaultValue: 'The rate is added on top of each line it applies to.' })}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <Field label={t('taxRates.form.name', { defaultValue: 'Name' })} error={fieldErr(errors.name?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="KDV %20" {...form.register('name')} />
              )}
            </Field>
            <Field label={t('taxRates.form.rate', { defaultValue: 'Rate (%)' })} error={fieldErr(errors.rate?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="number" step="0.01" min={0} max={100} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('rate')} />
              )}
            </Field>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t('taxRates.form.isDefault', { defaultValue: 'Use as the default rate' })}</span>
              <Switch checked={form.watch('isDefault')} onCheckedChange={(c) => form.setValue('isDefault', !!c)} />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button type="submit" loading={save.isPending}>
                {t('common.save', { defaultValue: 'Save' })}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!archiveTarget}
        onOpenChange={(o) => { if (!o) setArchiveTarget(null); }}
        title={t('taxRates.confirm.archiveTitle', { defaultValue: 'Archive tax rate' })}
        description={t('taxRates.confirm.archiveBody', { defaultValue: 'It is removed from the picker. Existing documents keep their snapshotted rate.' })}
        confirmLabel={t('taxRates.archive', { defaultValue: 'Archive' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => archiveTarget && remove.mutate(archiveTarget.id)}
        loading={remove.isPending}
      />
    </div>
  );
}
