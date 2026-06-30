import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Mail, Trash2, Pencil } from 'lucide-react';
import {
  listEmailTemplates, getEmailTemplate, createEmailTemplate, updateEmailTemplate, deleteEmailTemplate,
  type EmailTemplateRow, type EmailBlock,
} from '../../../features/marketing/api/email-templates.service';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '@/components/ui/Dialog';
import { EmailBlockBuilder } from './EmailBlockBuilder';

interface Draft { id?: string; name: string; blocks: EmailBlock[]; accent: string; compiledHtml?: string }
const EMPTY: Draft = { name: '', blocks: [], accent: '#1e40af' };

export default function EmailTemplatesPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EmailTemplateRow | null>(null);

  const { data: templates } = useQuery<EmailTemplateRow[]>({
    queryKey: ['marketing', 'email-templates'],
    queryFn: listEmailTemplates,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['marketing', 'email-templates'] });

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const payload = { name: d.name, blocks: d.blocks, theme: { accent: d.accent } };
      return d.id ? updateEmailTemplate(d.id, payload) : createEmailTemplate(payload);
    },
    onSuccess: (tpl) => {
      invalidate();
      // Keep the dialog open and refresh the preview from the server render.
      setDraft((d) => (d ? { ...d, id: tpl.id, compiledHtml: tpl.compiledHtml } : d));
      toast.success(t('email.saved', 'Template saved'));
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('email.saveFailed', 'Could not save template')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteEmailTemplate(id),
    onSuccess: () => { invalidate(); setDeleteTarget(null); },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('email.deleteFailed', 'Could not delete the template')),
  });

  const openEdit = async (id: string) => {
    const full = await getEmailTemplate(id);
    setDraft({ id: full.id, name: full.name, blocks: Array.isArray(full.blocks) ? full.blocks : [], accent: full.theme?.accent ?? '#1e40af', compiledHtml: full.compiledHtml });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('email.title', 'Email templates')}
        description={t('email.subtitle', 'Build branded HTML emails from blocks, then use them in campaigns.')}
        actions={<Button onClick={() => setDraft({ ...EMPTY })} size="md"><Plus className="h-4 w-4" />{t('email.new', 'New template')}</Button>}
      />

      {/* Builder dialog */}
      <Dialog open={!!draft} onOpenChange={(o) => { if (!o) setDraft(null); }}>
        <DialogContent className="max-w-4xl">
          {draft && (
            <>
              <DialogHeader>
                <DialogTitle>{draft.id ? t('email.edit', 'Edit template') : t('email.new', 'New template')}</DialogTitle>
                <DialogDescription>{t('email.hint', 'Compose with blocks on the left; Save to refresh the preview on the right.')}</DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3 items-center">
                <Field label={t('email.name', 'Name')}>
                  {({ id }) => <Input id={id} value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}
                </Field>
                <Field label={t('email.accent', 'Accent color')}>
                  {({ id }) => <Input id={id} type="text" value={draft.accent} placeholder="#1e40af" onChange={(e) => setDraft({ ...draft, accent: e.target.value })} />}
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <EmailBlockBuilder blocks={draft.blocks} onChange={(blocks) => setDraft({ ...draft, blocks })} />
                <div className="rounded-lg border border-border overflow-hidden bg-white">
                  {draft.compiledHtml ? (
                    <iframe title="preview" sandbox="" srcDoc={draft.compiledHtml} className="w-full h-[50vh] border-0" />
                  ) : (
                    <div className="h-[50vh] flex items-center justify-center text-caption text-muted-foreground p-4 text-center">
                      {t('email.previewHint', 'Save to render a preview.')}
                    </div>
                  )}
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDraft(null)}>{t('common.close', 'Close')}</Button>
                <Button onClick={() => save.mutate(draft)} loading={save.isPending} disabled={!draft.name.trim() || save.isPending}>
                  {t('common.save', 'Save')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('email.deleteTitle', 'Delete template?')}
        description={t('email.deleteDesc', 'Campaigns already sent are unaffected.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {(templates ?? []).map((tpl) => (
          <Card key={tpl.id}>
            <CardContent className="p-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Mail className="h-4 w-4 text-primary shrink-0" />
                <span className="font-medium text-foreground truncate">{tpl.name}</span>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <IconButton variant="ghost" size="sm" aria-label="Edit" onClick={() => openEdit(tpl.id)}><Pencil className="h-4 w-4" /></IconButton>
                <IconButton variant="ghost" size="sm" aria-label="Delete" className="text-danger hover:bg-danger-subtle" onClick={() => setDeleteTarget(tpl)}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {(templates ?? []).length === 0 && (
        <EmptyState
          icon={<Mail className="h-10 w-10" />}
          title={t('email.emptyTitle', 'No email templates yet')}
          description={t('email.empty', 'Build a branded HTML email and reuse it across campaigns.')}
          action={<Button onClick={() => setDraft({ ...EMPTY })}><Plus className="h-4 w-4" />{t('email.new', 'New template')}</Button>}
        />
      )}
    </div>
  );
}
