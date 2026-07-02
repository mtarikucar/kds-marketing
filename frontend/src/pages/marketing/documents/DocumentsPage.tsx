import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Send, Ban, Trash2, Pencil, Link2, FileSignature } from 'lucide-react';

import {
  listDocuments,
  getDocument,
  createDocument,
  updateDocument,
  sendDocument,
  voidDocument,
  deleteDocument,
  type MarketingDocument,
  type DocumentStatus,
} from '../../../features/marketing/api/documents.service';
import {
  PageHeader,
  Button,
  Card,
  CardContent,
  Badge,
  QueryStateBoundary,
  EmptyState,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Input,
  Textarea,
} from '@/components/ui';

const STATUS_TONE: Record<DocumentStatus, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  DRAFT: 'neutral',
  SENT: 'info',
  SIGNED: 'success',
  DECLINED: 'danger',
  VOIDED: 'warning',
};

interface FormState {
  id?: string;
  status?: DocumentStatus;
  title: string;
  body: string;
}
const EMPTY_FORM: FormState = { title: '', body: '' };

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}

/**
 * E-signature Documents / contracts (GoHighLevel parity). Authors a document,
 * sends it for signature (copy the public signing link), and tracks status.
 * The signer page is server-rendered at /api/public/d/:token (no React route).
 * Reps can draft; send/void/delete are manager-gated server-side.
 */
export default function DocumentsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const { data: docs, isLoading, isError, refetch } = useQuery({
    queryKey: ['marketing', 'documents'],
    queryFn: listDocuments,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'documents'] });
  const onError = (e: unknown) =>
    toast.error(
      (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        t('documents.saveError', 'Could not save'),
    );

  const saveMutation = useMutation({
    mutationFn: (f: FormState) =>
      f.id
        ? updateDocument(f.id, { title: f.title.trim(), body: f.body })
        : createDocument({ title: f.title.trim(), body: f.body }),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      toast.success(t('documents.saved', 'Saved'));
    },
    onError,
  });

  const copyLink = async (id: string) => {
    try {
      const { publicToken } = await sendDocument(id); // idempotent: returns token
      const url = `${window.location.origin}/api/public/d/${publicToken}`;
      await navigator.clipboard.writeText(url);
      invalidate();
      toast.success(t('documents.linkCopied', 'Signing link copied'));
    } catch (e) {
      onError(e);
    }
  };

  const voidMut = useMutation({
    mutationFn: voidDocument,
    onSuccess: () => { invalidate(); toast.success(t('documents.voided', 'Voided')); },
    onError,
  });
  const deleteMut = useMutation({
    mutationFn: deleteDocument,
    onSuccess: () => { invalidate(); toast.success(t('documents.deleted', 'Document deleted')); },
    onError,
  });

  const openNew = () => {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };
  const openEdit = async (d: MarketingDocument) => {
    // Fetch the full body (the list payload omits it).
    try {
      const full = await getDocument(d.id);
      setForm({ id: d.id, status: d.status, title: full.title, body: full.body ?? '' });
      setDialogOpen(true);
    } catch (e) {
      onError(e);
    }
  };

  const isDraft = !form.id || form.status === 'DRAFT';
  const rows = docs ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('documents.title', 'Documents')}
        description={t('documents.subtitle', 'Agreements you send for e-signature.')}
        actions={
          <Button size="md" onClick={openNew}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            {t('documents.newDocument', 'New document')}
          </Button>
        }
      />

      <QueryStateBoundary
        isLoading={isLoading}
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('common.loadError', 'Could not load. Please try again.')}
      />

      {!isLoading && !isError && rows.length === 0 && (
        <EmptyState
          title={t('documents.emptyTitle', 'No documents yet')}
          description={t('documents.empty', 'Draft an agreement and send it for e-signature.')}
          action={
            <Button size="sm" onClick={openNew}>
              <Plus className="w-4 h-4" aria-hidden="true" />
              {t('documents.newDocument', 'New document')}
            </Button>
          }
        />
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((d) => (
            <Card key={d.id} className={d.status === 'VOIDED' || d.status === 'DECLINED' ? 'opacity-60' : ''}>
              <CardContent className="p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <FileSignature className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
                    <p className="font-medium text-foreground truncate">{d.title}</p>
                    <Badge tone={STATUS_TONE[d.status]} size="sm">
                      {t(`documents.status.${d.status}`, d.status)}
                    </Badge>
                  </div>
                  {d.status === 'SIGNED' && d.signerName && (
                    <p className="text-caption text-muted-foreground mt-0.5">
                      {t('documents.signedBy', 'Signed by {{name}} on {{date}}', {
                        name: d.signerName,
                        date: d.signedAt ? new Date(d.signedAt).toLocaleDateString() : '',
                      })}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {d.status === 'DRAFT' && (
                    <Button variant="ghost" size="sm" onClick={() => openEdit(d)} title={t('common.edit', 'Edit')}>
                      <Pencil className="w-4 h-4" aria-hidden="true" />
                    </Button>
                  )}
                  {(d.status === 'DRAFT' || d.status === 'SENT') && (
                    <Button variant="ghost" size="sm" onClick={() => copyLink(d.id)} title={t('documents.copyLink', 'Copy signing link')}>
                      {d.status === 'DRAFT' ? <Send className="w-4 h-4" aria-hidden="true" /> : <Link2 className="w-4 h-4" aria-hidden="true" />}
                    </Button>
                  )}
                  {/* Per-row in-flight guard (mutation.variables === d.id): a
                      double-click can't re-fire — Delete's second click would 404
                      after the row is gone — and acting on one document doesn't
                      disable the same action on the others. */}
                  {d.status !== 'SIGNED' && (
                    <Button variant="ghost" size="sm" disabled={voidMut.isPending && voidMut.variables === d.id} onClick={() => voidMut.mutate(d.id)} title={t('documents.void', 'Void')}>
                      <Ban className="w-4 h-4 text-danger" aria-hidden="true" />
                    </Button>
                  )}
                  {d.status !== 'SIGNED' && (
                    <Button variant="ghost" size="sm" disabled={deleteMut.isPending && deleteMut.variables === d.id} onClick={() => deleteMut.mutate(d.id)} title={t('common.delete', 'Delete')}>
                      <Trash2 className="w-4 h-4 text-danger" aria-hidden="true" />
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
              {form.id ? t('documents.editDocument', 'Edit document') : t('documents.newDocument', 'New document')}
            </DialogTitle>
          </DialogHeader>
          {!isDraft ? (
            <p className="text-sm text-muted-foreground">
              {t('documents.readonlyNote', 'A sent document is read-only.')}
            </p>
          ) : (
            <div className="space-y-3">
              <Labeled label={t('documents.titleField', 'Title')}>
                <Input
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder={t('documents.titlePlaceholder', 'Service agreement')}
                />
              </Labeled>
              <Labeled label={t('documents.body', 'Body')}>
                <Textarea
                  rows={10}
                  value={form.body}
                  onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                  placeholder={t('documents.bodyPlaceholder', 'The full text of the agreement…')}
                />
              </Labeled>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              {t('common.close', 'Close')}
            </Button>
            {isDraft && (
              <Button
                size="sm"
                disabled={saveMutation.isPending || !form.title.trim() || !form.body.trim()}
                onClick={() => saveMutation.mutate(form)}
              >
                {t('common.save', 'Save')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
