import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Globe, Trash2, Sparkles, Clipboard, Eye, EyeOff, Plus, Pencil } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
} from '@/components/ui/Table';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PageRow { id: string; slug: string; title: string; published: boolean }
interface FormRow { id: string; name: string; fields?: unknown[] }

// ── Schemas ───────────────────────────────────────────────────────────────────

const pageSchema = z.object({
  title: z.string().min(1, 'Required').max(120),
  slug: z.string().max(80).optional(),
  blocks: z.string().refine(
    (v) => { try { JSON.parse(v || '[]'); return true; } catch { return false; } },
    { message: 'Must be valid JSON' },
  ),
});
type PageFormValues = z.infer<typeof pageSchema>;

const formSchema = z.object({
  name: z.string().min(1, 'Required'),
});
type FormFormValues = z.infer<typeof formSchema>;

// ── Badge helpers ─────────────────────────────────────────────────────────────

function publishedTone(published: boolean) {
  return published ? ('success' as const) : ('neutral' as const);
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SitesPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const wsId = (useMarketingAuthStore().user as any)?.workspaceId as string | undefined;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteFormTarget, setDeleteFormTarget] = useState<string | null>(null);

  // Page form (RHF)
  const {
    register,
    handleSubmit,
    reset: resetPage,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<PageFormValues>({
    resolver: zodResolver(pageSchema),
    defaultValues: { title: '', slug: '', blocks: '[]' },
  });

  // Form-creator form (RHF)
  const {
    register: regForm,
    handleSubmit: handleFormSubmit,
    reset: resetFormForm,
    formState: { errors: formErrors },
  } = useForm<FormFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '' },
  });

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: pages } = useQuery<PageRow[]>({
    queryKey: ['marketing', 'sites'],
    queryFn: () => marketingApi.get('/sites').then((r) => r.data),
  });
  const { data: forms } = useQuery<FormRow[]>({
    queryKey: ['marketing', 'sites', 'forms'],
    queryFn: () => marketingApi.get('/sites/forms').then((r) => r.data),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'sites'] });

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const save = useMutation({
    mutationFn: (values: PageFormValues) => {
      let blocks: unknown;
      try { blocks = JSON.parse(values.blocks || '[]'); } catch { throw new Error(t('sites.badBlocks', 'Blocks are not valid JSON')); }
      const payload = { title: values.title, slug: values.slug || undefined, blocks };
      return editId ? marketingApi.patch(`/sites/${editId}`, payload) : marketingApi.post('/sites', payload);
    },
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setEditId(null);
      resetPage();
      setAiPrompt('');
      toast.success(t('sites.saved', 'Page saved'));
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? e.message ?? t('sites.saveFailed', 'Save failed')),
  });

  const draft = useMutation({
    mutationFn: () => marketingApi.post('/sites/draft', { prompt: aiPrompt }),
    onSuccess: ({ data }) => {
      setValue('title', data.title || '');
      setValue('blocks', JSON.stringify(data.blocks ?? [], null, 2));
      toast.success(t('sites.drafted', 'Draft ready'));
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('sites.draftFailed', 'Could not draft')),
  });

  const publish = useMutation({
    mutationFn: ({ id, p }: { id: string; p: boolean }) => marketingApi.post(`/sites/${id}/publish`, { published: p }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/sites/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); },
  });

  const createForm = useMutation({
    mutationFn: (values: FormFormValues) => marketingApi.post('/sites/forms', {
      name: values.name,
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'phone', label: 'Phone', type: 'tel' },
      ],
    }),
    onSuccess: () => {
      resetFormForm();
      queryClient.invalidateQueries({ queryKey: ['marketing', 'sites', 'forms'] });
      toast.success(t('sites.formCreated', 'Form created'));
    },
  });

  const removeForm = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/sites/forms/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'sites', 'forms'] });
      setDeleteFormTarget(null);
    },
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const openCreate = () => {
    setEditId(null);
    resetPage({ title: '', slug: '', blocks: '[]' });
    setAiPrompt('');
    setDialogOpen(true);
  };

  const openEdit = async (p: PageRow) => {
    const full = await marketingApi.get(`/sites/${p.id}`).then((r) => r.data);
    setEditId(full.id);
    resetPage({
      title: full.title,
      slug: full.slug,
      blocks: JSON.stringify(full.blocks ?? [], null, 2),
    });
    setAiPrompt('');
    setDialogOpen(true);
  };

  const publicUrl = (slug: string) =>
    `${window.location.origin}/api/public/p/${wsId ?? ':workspace'}/${slug}`;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('sites.title', 'Funnels & Pages')}
        description={t('sites.subtitle', 'Build landing pages with lead-capture forms. Describe one and AI drafts the blocks.')}
        actions={
          <Button onClick={openCreate} size="md">
            <Plus className="h-4 w-4" />
            {t('sites.new', 'New page')}
          </Button>
        }
      />

      {/* Pages list */}
      {(pages ?? []).length === 0 ? (
        <EmptyState
          icon={<Globe className="h-10 w-10" />}
          title={t('sites.empty', 'No pages yet')}
          description={t('sites.emptyDesc', 'Describe one and let AI draft it.')}
          action={
            <Button onClick={openCreate} size="sm">
              <Plus className="h-4 w-4" />
              {t('sites.new', 'New page')}
            </Button>
          }
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>{t('sites.pageTitle', 'Title')}</TH>
                <TH>{t('sites.slug', 'Slug')}</TH>
                <TH>{t('common.status', 'Status')}</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {(pages ?? []).map((p) => (
                <TR key={p.id}>
                  <TD className="font-medium text-foreground">
                    <span className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-primary shrink-0" />
                      {p.title}
                    </span>
                  </TD>
                  <TD className="text-muted-foreground text-sm">/{p.slug}</TD>
                  <TD>
                    <Badge tone={publishedTone(p.published)}>
                      {p.published ? t('sites.published', 'Published') : t('sites.draft', 'Draft')}
                    </Badge>
                  </TD>
                  <TD>
                    <div className="flex items-center justify-end gap-1">
                      {p.published && (
                        <IconButton
                          aria-label={t('sites.copyUrl', 'Copy public URL')}
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            navigator.clipboard.writeText(publicUrl(p.slug));
                            toast.success(t('common.copied', 'Copied'));
                          }}
                        >
                          <Clipboard className="h-4 w-4" />
                        </IconButton>
                      )}
                      <IconButton
                        aria-label={p.published ? t('sites.unpublish', 'Unpublish') : t('sites.publish', 'Publish')}
                        size="sm"
                        variant="ghost"
                        onClick={() => publish.mutate({ id: p.id, p: !p.published })}
                      >
                        {p.published ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </IconButton>
                      <IconButton
                        aria-label={t('common.edit', 'Edit')}
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(p)}
                      >
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                      <IconButton
                        aria-label={t('common.delete', 'Delete')}
                        size="sm"
                        variant="ghost"
                        className="text-danger hover:text-danger"
                        onClick={() => setDeleteTarget(p.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {/* Lead-capture forms */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sites.forms', 'Lead-capture forms')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            onSubmit={handleFormSubmit((v) => createForm.mutate(v))}
            className="flex gap-2"
          >
            <Field
              error={formErrors.name?.message}
              className="flex-1"
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder={t('sites.formName', 'Form name (name/email/phone fields)')}
                  {...regForm('name')}
                />
              )}
            </Field>
            <Button type="submit" variant="secondary" disabled={createForm.isPending}>
              {t('sites.addForm', 'Add')}
            </Button>
          </form>

          {(forms ?? []).length > 0 ? (
            <Table>
              <TBody>
                {(forms ?? []).map((f) => (
                  <TR key={f.id}>
                    <TD>
                      <span className="text-muted-foreground text-xs font-mono">{f.id.slice(0, 8)}</span>
                      {' '}{f.name}
                    </TD>
                    <TD>
                      <div className="flex justify-end">
                        <IconButton
                          aria-label={t('common.delete', 'Delete')}
                          size="sm"
                          variant="ghost"
                          className="text-danger hover:text-danger"
                          onClick={() => setDeleteFormTarget(f.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <p className="text-caption text-muted-foreground">
              {t('sites.noForms', 'No forms yet. Add one, then reference it in a page form block: {"type":"form","formId":"…"}.')}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Create / Edit page dialog */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) { setDialogOpen(false); setEditId(null); resetPage(); setAiPrompt(''); }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editId ? t('sites.editPage', 'Edit page') : t('sites.new', 'New page')}
            </DialogTitle>
            <DialogDescription>
              {t('sites.dialogDesc', 'Fill in the title, optional slug, and blocks JSON. Use AI to draft.')}
            </DialogDescription>
          </DialogHeader>

          {/* AI draft strip */}
          <div className="flex gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <Input
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder={t('sites.aiPlaceholder', 'Describe the page — e.g. a demo-booking page for a coffee POS')}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => draft.mutate()}
              disabled={!aiPrompt.trim() || draft.isPending}
              loading={draft.isPending}
              className="shrink-0"
            >
              <Sparkles className="h-4 w-4" />
              {t('sites.draftBtn', 'Draft')}
            </Button>
          </div>

          <form
            id="sites-page-form"
            onSubmit={handleSubmit((v) => save.mutate(v))}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('sites.pageTitle', 'Title')} error={errors.title?.message} required>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    maxLength={120}
                    {...register('title')}
                  />
                )}
              </Field>
              <Field label={t('sites.slug', 'Slug')} error={errors.slug?.message}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    placeholder="demo"
                    maxLength={80}
                    {...register('slug')}
                  />
                )}
              </Field>
            </div>
            <Field label={t('sites.blocks', 'Blocks (JSON)')} error={errors.blocks?.message}>
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className="min-h-48 font-mono text-xs"
                  {...register('blocks')}
                />
              )}
            </Field>
          </form>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => { setDialogOpen(false); setEditId(null); resetPage(); setAiPrompt(''); }}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              form="sites-page-form"
              loading={save.isPending || isSubmitting}
            >
              {t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete page confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('sites.deleteTitle', 'Delete page?')}
        description={t('sites.deleteDesc', 'This action cannot be undone.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
        loading={remove.isPending}
      />

      {/* Delete form confirm */}
      <ConfirmDialog
        open={!!deleteFormTarget}
        onOpenChange={(open) => { if (!open) setDeleteFormTarget(null); }}
        title={t('sites.deleteFormTitle', 'Delete form?')}
        description={t('sites.deleteFormDesc', 'This action cannot be undone.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        onConfirm={() => deleteFormTarget && removeForm.mutate(deleteFormTarget)}
        loading={removeForm.isPending}
      />
    </div>
  );
}
