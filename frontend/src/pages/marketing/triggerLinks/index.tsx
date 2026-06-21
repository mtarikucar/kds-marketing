import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Link2, Copy, QrCode, MousePointerClick } from 'lucide-react';
import {
  listTriggerLinks,
  createTriggerLink,
  updateTriggerLink,
  deleteTriggerLink,
  downloadTriggerLinkQr,
  type TriggerLink,
} from '../../../features/marketing/api/trigger-links.service';
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
  name: z.string().trim().min(1, 'required').max(120),
  targetUrl: z.string().trim().url('url').max(2000),
  slug: z.string().trim().max(60).regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug').optional().or(z.literal('')),
});
type FormValues = z.infer<typeof schema>;

export default function TriggerLinksPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TriggerLink | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TriggerLink | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['marketing', 'trigger-links'], queryFn: listTriggerLinks });
  const links: TriggerLink[] = Array.isArray(data) ? data : [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'trigger-links'] });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', targetUrl: '', slug: '' },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ name: '', targetUrl: '', slug: '' });
    setOpen(true);
  };
  const openEdit = (l: TriggerLink) => {
    setEditing(l);
    form.reset({ name: l.name, targetUrl: l.targetUrl, slug: l.slug });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const payload = { name: v.name, targetUrl: v.targetUrl, slug: v.slug || undefined };
      return editing ? updateTriggerLink(editing.id, payload) : createTriggerLink(payload);
    },
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setEditing(null);
      toast.success(t('triggerLinks.toast.saved', { defaultValue: 'Trigger link saved' }));
    },
    onError: (e) => toast.error(apiError(e, t('triggerLinks.toast.failed', { defaultValue: 'Failed to save' }))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteTriggerLink(id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('triggerLinks.toast.deleted', { defaultValue: 'Trigger link deleted' }));
    },
    onError: (e) => toast.error(apiError(e, t('triggerLinks.toast.deleteFailed', { defaultValue: 'Failed to delete' }))),
  });

  const copy = (url: string) => {
    navigator.clipboard?.writeText(url).then(
      () => toast.success(t('triggerLinks.copied', { defaultValue: 'Link copied' })),
      () => toast.error(t('triggerLinks.copyFailed', { defaultValue: 'Copy failed' })),
    );
  };

  const fieldErr = (m?: string) => (m ? t([`validation.${m}`, m], { defaultValue: m }) : undefined);
  const errors = form.formState.errors;
  const handleSubmit: SubmitHandler<FormValues> = (v) => save.mutate(v);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('triggerLinks.title', { defaultValue: 'Trigger Links' })}
        description={t('triggerLinks.subtitle', {
          defaultValue: 'Trackable short links that fire a workflow on every click, with QR codes.',
        })}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('triggerLinks.new', { defaultValue: 'New link' })}
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-40" />
      ) : links.length === 0 ? (
        <EmptyState
          icon={<Link2 className="h-10 w-10" />}
          title={t('triggerLinks.empty.title', { defaultValue: 'No trigger links yet' })}
          description={t('triggerLinks.empty.description', {
            defaultValue: 'Create a trackable link to drive automations from clicks.',
          })}
          action={
            <Button onClick={openCreate} variant="outline">
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('triggerLinks.new', { defaultValue: 'New link' })}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((l) => (
            <Card key={l.id} className="flex flex-col gap-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{l.name}</p>
                  <p className="truncate text-micro text-muted-foreground">{l.targetUrl}</p>
                </div>
                <Badge tone="neutral" size="sm">
                  <MousePointerClick className="h-3 w-3" aria-hidden="true" /> {l.clickCount}
                </Badge>
              </div>
              <p className="truncate rounded bg-surface-muted px-2 py-1 font-mono text-micro text-primary">{l.url}</p>
              <div className="mt-auto flex items-center justify-end gap-1 pt-1">
                <IconButton variant="ghost" size="sm" aria-label={t('triggerLinks.copy', { defaultValue: 'Copy link' })} onClick={() => copy(l.url)}>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton variant="ghost" size="sm" aria-label={t('triggerLinks.qr', { defaultValue: 'Download QR' })} onClick={() => downloadTriggerLinkQr(l.id, l.slug)}>
                  <QrCode className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton variant="ghost" size="sm" aria-label={t('common.edit', { defaultValue: 'Edit' })} onClick={() => openEdit(l)}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton variant="ghost" size="sm" aria-label={t('common.delete', { defaultValue: 'Delete' })} onClick={() => setDeleteTarget(l)}>
                  <Trash2 className="h-4 w-4 text-danger" aria-hidden="true" />
                </IconButton>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? t('triggerLinks.form.editTitle', { defaultValue: 'Edit trigger link' }) : t('triggerLinks.form.newTitle', { defaultValue: 'New trigger link' })}
            </DialogTitle>
            <DialogDescription>
              {t('triggerLinks.form.subtitle', { defaultValue: 'Each click 302s to the target and fires the link.clicked workflow trigger.' })}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <Field label={t('triggerLinks.form.name', { defaultValue: 'Name' })} error={fieldErr(errors.name?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('name')} />
              )}
            </Field>
            <Field label={t('triggerLinks.form.targetUrl', { defaultValue: 'Target URL' })} error={fieldErr(errors.targetUrl?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="https://example.com/landing" {...form.register('targetUrl')} />
              )}
            </Field>
            <Field
              label={t('triggerLinks.form.slug', { defaultValue: 'Custom slug (optional)' })}
              hint={t('triggerLinks.form.slugHint', { defaultValue: 'Leave blank to auto-generate. Immutable-feeling public id.' })}
              error={fieldErr(errors.slug?.message)}
            >
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="spring-promo" {...form.register('slug')} />
              )}
            </Field>
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
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('triggerLinks.confirm.deleteTitle', { defaultValue: 'Delete trigger link' })}
        description={t('triggerLinks.confirm.deleteBody', { defaultValue: 'The short link stops working and its click history is removed.' })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        loading={remove.isPending}
      />
    </div>
  );
}
