import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, MessageSquareText, Users, Lock, Sparkles } from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import {
  listSnippets,
  createSnippet,
  updateSnippet,
  deleteSnippet,
  type MessageSnippet,
} from '../../../../features/marketing/api/snippets.service';
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
  Textarea,
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
  shortcut: z.string().trim().min(1, 'required').max(40).regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug'),
  title: z.string().trim().min(1, 'required').max(120),
  body: z.string().trim().min(1, 'required').max(5000),
  shared: z.boolean(),
});
type FormValues = z.infer<typeof schema>;

export default function SnippetsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MessageSnippet | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MessageSnippet | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['marketing', 'snippets'], queryFn: listSnippets });
  const snippets: MessageSnippet[] = Array.isArray(data) ? data : [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'snippets'] });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { shortcut: '', title: '', body: '', shared: true },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ shortcut: '', title: '', body: '', shared: true });
    setOpen(true);
  };
  const openEdit = (s: MessageSnippet) => {
    setEditing(s);
    form.reset({ shortcut: s.shortcut, title: s.title, body: s.body, shared: s.ownerId === null });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      editing
        ? updateSnippet(editing.id, { title: v.title, body: v.body, shared: v.shared })
        : createSnippet(v),
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setEditing(null);
      toast.success(t('snippets.toast.saved', { defaultValue: 'Snippet saved' }));
    },
    onError: (e) => toast.error(apiError(e, t('snippets.toast.failed', { defaultValue: 'Failed to save' }))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteSnippet(id),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast.success(t('snippets.toast.deleted', { defaultValue: 'Snippet deleted' }));
    },
    onError: (e) => toast.error(apiError(e, t('snippets.toast.deleteFailed', { defaultValue: 'Failed to delete' }))),
  });

  // "AI ile doldur" — drafts the reply body from the title using the shared
  // content-AI composer (POST /ai/compose). Canned replies are short, so we ask
  // for the concise 'sms' style; the model answers in the workspace language.
  const compose = useMutation({
    mutationFn: (goal: string) =>
      marketingApi
        .post('/ai/compose', {
          kind: 'sms',
          goal: `A reusable canned reply an agent inserts into a live customer conversation. Topic/intent: ${goal}`,
        })
        .then((r) => r.data as { body?: string }),
    onSuccess: (data) => {
      if (data.body) {
        form.setValue('body', data.body, { shouldValidate: true, shouldDirty: true });
        toast.success(t('snippets.form.aiDone', { defaultValue: 'AI draft ready' }));
      }
    },
    onError: (e) => toast.error(apiError(e, t('snippets.form.aiFailed', { defaultValue: 'AI could not fill this in' }))),
  });

  const handleAiFill = () => {
    const goal = form.getValues('title').trim();
    if (!goal) {
      toast.error(t('snippets.form.aiNeedTitle', { defaultValue: 'Add a title first — the AI drafts the reply from it' }));
      form.setFocus('title');
      return;
    }
    compose.mutate(goal);
  };

  const fieldErr = (m?: string) => (m ? t([`validation.${m}`, m], { defaultValue: m }) : undefined);
  const errors = form.formState.errors;
  const handleSubmit: SubmitHandler<FormValues> = (v) => save.mutate(v);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('snippets.title', { defaultValue: 'Canned Responses' })}
        description={t('snippets.subtitle', {
          defaultValue: 'Reusable replies your team inserts in the inbox by typing /shortcut.',
        })}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('snippets.new', { defaultValue: 'New snippet' })}
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-40" />
      ) : snippets.length === 0 ? (
        <EmptyState
          icon={<MessageSquareText className="h-10 w-10" />}
          title={t('snippets.empty.title', { defaultValue: 'No snippets yet' })}
          description={t('snippets.empty.description', {
            defaultValue: 'Create canned responses to reply faster in the inbox.',
          })}
          action={
            <Button onClick={openCreate} variant="outline">
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('snippets.new', { defaultValue: 'New snippet' })}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {snippets.map((s) => (
            <Card key={s.id} className="flex flex-col gap-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{s.title}</p>
                  <p className="truncate font-mono text-micro text-primary">/{s.shortcut}</p>
                </div>
                <Badge tone="neutral" size="sm">
                  {s.ownerId === null ? (
                    <><Users className="h-3 w-3" aria-hidden="true" /> {t('snippets.shared', { defaultValue: 'Shared' })}</>
                  ) : (
                    <><Lock className="h-3 w-3" aria-hidden="true" /> {t('snippets.private', { defaultValue: 'Private' })}</>
                  )}
                </Badge>
              </div>
              <p className="line-clamp-3 text-micro text-muted-foreground">{s.body}</p>
              <div className="mt-auto flex items-center justify-end gap-1 pt-1">
                <IconButton variant="ghost" size="sm" aria-label={t('common.edit', { defaultValue: 'Edit' })} onClick={() => openEdit(s)}>
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton variant="ghost" size="sm" aria-label={t('common.delete', { defaultValue: 'Delete' })} onClick={() => setDeleteTarget(s)}>
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
              {editing
                ? t('snippets.form.editTitle', { defaultValue: 'Edit snippet' })
                : t('snippets.form.newTitle', { defaultValue: 'New snippet' })}
            </DialogTitle>
            <DialogDescription>
              {t('snippets.form.subtitle', { defaultValue: 'Agents insert this by typing /shortcut in the composer.' })}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <Field label={t('snippets.form.shortcut', { defaultValue: 'Shortcut' })} error={fieldErr(errors.shortcut?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} placeholder="greeting" disabled={!!editing} {...form.register('shortcut')} />
              )}
            </Field>
            <Field label={t('snippets.form.titleLabel', { defaultValue: 'Title' })} error={fieldErr(errors.title?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('title')} />
              )}
            </Field>
            <Field label={t('snippets.form.body', { defaultValue: 'Message' })} error={fieldErr(errors.body?.message)} required>
              {({ id, describedBy, invalid }) => (
                <div className="space-y-1.5">
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleAiFill}
                      loading={compose.isPending}
                      disabled={compose.isPending}
                    >
                      <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('snippets.form.aiFill', { defaultValue: 'Fill with AI' })}
                    </Button>
                  </div>
                  <Textarea id={id} rows={5} aria-describedby={describedBy} aria-invalid={invalid} {...form.register('body')} />
                </div>
              )}
            </Field>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>{t('snippets.form.shared', { defaultValue: 'Share with the whole team' })}</span>
              <Switch checked={form.watch('shared')} onCheckedChange={(c) => form.setValue('shared', !!c)} />
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
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('snippets.confirm.deleteTitle', { defaultValue: 'Delete snippet' })}
        description={t('snippets.confirm.deleteBody', { defaultValue: 'This permanently removes the snippet.' })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
        loading={remove.isPending}
      />
    </div>
  );
}
