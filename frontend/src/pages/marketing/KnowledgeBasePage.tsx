import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { BookOpen, Trash2, Archive, Plus, Pencil } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

// ── Types ─────────────────────────────────────────────────────────────────────

interface KnowledgeRow {
  id: string;
  title: string;
  source: string;
  language: string;
  status: 'ACTIVE' | 'ARCHIVED';
  updatedAt: string;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const docSchema = z.object({
  title: z.string().min(1, 'Required').max(200),
  content: z.string().min(1, 'Required').max(50000),
  language: z.string().min(1),
});

type DocFormValues = z.infer<typeof docSchema>;

const DEFAULT_VALUES: DocFormValues = { title: '', content: '', language: 'tr' };

const LANGUAGES = [
  { value: 'tr', label: 'Türkçe' },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
  { value: 'uz', label: 'Oʻzbekcha' },
  { value: 'ar', label: 'العربية' },
];

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Knowledge Base: the facts the AI grounds its answers on (menus, policies,
 * FAQs, hours). Full-text searched at answer time. Manager+ surface, gated on
 * the `agentStudio` feature.
 */
export default function KnowledgeBasePage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const { data: docs } = useQuery<KnowledgeRow[]>({
    queryKey: ['marketing', 'ai', 'knowledge'],
    queryFn: () => marketingApi.get('/ai/knowledge').then((r) => r.data),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'ai', 'knowledge'] });

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm<DocFormValues>({
    resolver: zodResolver(docSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const contentValue = watch('content');

  const saveDoc = useMutation({
    mutationFn: (values: DocFormValues) => {
      const payload = { title: values.title, content: values.content, language: values.language };
      return editingId
        ? marketingApi.patch(`/ai/knowledge/${editingId}`, payload)
        : marketingApi.post('/ai/knowledge', payload);
    },
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setEditingId(null);
      reset(DEFAULT_VALUES);
      toast.success(t('knowledge.saved', 'Document saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('knowledge.saveFailed', 'Save failed')),
  });

  const archiveDoc = useMutation({
    mutationFn: (d: KnowledgeRow) =>
      marketingApi.patch(`/ai/knowledge/${d.id}`, {
        status: d.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE',
      }),
    onSuccess: invalidate,
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('knowledge.archiveFailed', 'Could not update the document')),
  });

  const deleteDoc = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/ai/knowledge/${id}`),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('knowledge.deleteFailed', 'Could not delete the document')),
  });

  const openCreate = () => {
    setEditingId(null);
    reset(DEFAULT_VALUES);
    setOpen(true);
  };

  const openEdit = async (d: KnowledgeRow) => {
    try {
      const full = await marketingApi.get(`/ai/knowledge/${d.id}`).then((r) => r.data);
      setEditingId(d.id);
      reset({ title: full.title, content: full.content, language: full.language });
      setOpen(true);
    } catch (e: any) {
      toast.error(
        e.response?.data?.message ?? t('knowledge.loadFailed', 'Could not load document'),
      );
    }
  };

  return (
    <div className="space-y-6">
      {!embedded && (
      <PageHeader
        title={t('knowledge.title', 'Knowledge Base')}
        description={t(
          'knowledge.subtitle',
          'The facts your AI answers from — menus, hours, policies, FAQs. Attach docs to an agent in Agent Studio.',
        )}
        actions={
          <Button onClick={openCreate} size="md">
            <Plus className="h-4 w-4" />
            {t('knowledge.new', 'New document')}
          </Button>
        }
      />
      )}

      {/* Embedded (Inbox tab): no page header, so the create CTA moves into a
          toolbar row (the empty state below carries its own when there's none). */}
      {embedded && (docs ?? []).length > 0 && (
        <div className="flex justify-end">
          <Button onClick={openCreate} size="md">
            <Plus className="h-4 w-4" />
            {t('knowledge.new', 'New document')}
          </Button>
        </div>
      )}

      {/* Document list */}
      <div className="space-y-3">
        {(docs ?? []).map((d) => (
          <Card key={d.id}>
            <CardContent className="pt-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <BookOpen className="h-5 w-5 text-primary shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground truncate">{d.title}</span>
                      <span className="text-xs uppercase text-muted-foreground">{d.language}</span>
                      {d.status === 'ARCHIVED' && (
                        <Badge tone="neutral" size="sm">
                          {t('knowledge.archived', 'archived')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t('knowledge.updated', 'updated')}{' '}
                      {new Date(d.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="outline" size="sm" onClick={() => openEdit(d)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t('common.edit', 'Edit')}
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t('knowledge.toggleArchive', 'Archive / restore')}
                    onClick={() => archiveDoc.mutate(d)}
                  >
                    <Archive className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="Delete document"
                    className="text-danger hover:bg-danger-subtle"
                    onClick={() => setDeleteTarget(d.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {(docs ?? []).length === 0 && (
          <EmptyState
            icon={<BookOpen className="h-10 w-10" />}
            title={t('knowledge.empty', 'No documents yet')}
            description={t(
              'knowledge.emptyDesc',
              'Add the facts your AI should answer from.',
            )}
            action={
              <Button onClick={openCreate} size="md">
                <Plus className="h-4 w-4" />
                {t('knowledge.new', 'New document')}
              </Button>
            }
          />
        )}
      </div>

      {/* Create / Edit Dialog */}
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) {
            setOpen(false);
            setEditingId(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId
                ? t('knowledge.edit', 'Edit document')
                : t('knowledge.new', 'New document')}
            </DialogTitle>
            <DialogDescription>
              {t('knowledge.formDesc', 'Paste the facts the AI should know.')}
            </DialogDescription>
          </DialogHeader>

          <form
            id="knowledge-form"
            onSubmit={handleSubmit((v) => saveDoc.mutate(v))}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <Field
                  label={t('knowledge.docTitle', 'Title')}
                  error={errors.title?.message}
                  required
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={invalid}
                      maxLength={200}
                      placeholder={t('knowledge.titlePlaceholder', 'e.g. Menu & prices')}
                      {...register('title')}
                    />
                  )}
                </Field>
              </div>

              <Field
                label={t('knowledge.language', 'Language')}
                error={errors.language?.message}
                required
              >
                {({ id }) => (
                  <Controller
                    name="language"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id={id}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LANGUAGES.map((l) => (
                            <SelectItem key={l.value} value={l.value}>
                              {l.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                )}
              </Field>
            </div>

            <Field
              label={t('knowledge.content', 'Content')}
              error={errors.content?.message}
              hint={`${contentValue?.length ?? 0}/50000`}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className="min-h-48 font-mono"
                  maxLength={50000}
                  placeholder={t(
                    'knowledge.contentPlaceholder',
                    'Paste the facts the AI should know. Plain text works best.',
                  )}
                  {...register('content')}
                />
              )}
            </Field>
          </form>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                setEditingId(null);
              }}
              disabled={saveDoc.isPending}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" form="knowledge-form" loading={saveDoc.isPending}>
              {t('common.save', 'Save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        title={t('knowledge.deleteTitle', 'Delete document?')}
        description={t('knowledge.deleteDesc', 'This cannot be undone.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={deleteDoc.isPending}
        onConfirm={() => deleteTarget && deleteDoc.mutate(deleteTarget)}
      />
    </div>
  );
}
