import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Sparkles, Trash2, Star, Plus } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
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
  Table,
  TBody,
  TR,
  TD,
} from '@/components/ui/Table';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Review {
  id: string;
  rating?: number | null;
  text?: string | null;
  status: string;
  replyDraft?: string | null;
  replyText?: string | null;
  createdAt: string;
}
interface Source { id: string; name: string; placeUrl: string }

// ── Schemas ───────────────────────────────────────────────────────────────────

const sourceSchema = z.object({
  name: z.string().min(1, 'Required'),
  placeUrl: z.string().url('Must be a valid URL').min(1, 'Required'),
});
type SourceFormValues = z.infer<typeof sourceSchema>;

// ── Badge helpers ─────────────────────────────────────────────────────────────

function reviewStatusTone(status: string) {
  if (status === 'PRIVATE_FEEDBACK') return 'danger' as const;
  if (status === 'PUBLIC_ROUTED') return 'success' as const;
  if (status === 'REPLIED') return 'info' as const;
  return 'neutral' as const;
}

function reviewStatusLabel(status: string, t: (k: string, d: string) => string) {
  if (status === 'PRIVATE_FEEDBACK') return t('reviews.statusPrivate', 'Private feedback');
  if (status === 'PUBLIC_ROUTED') return t('reviews.statusPublic', 'Public routed');
  if (status === 'REPLIED') return t('reviews.statusReplied', 'Replied');
  return status;
}

// ── Stars helper ──────────────────────────────────────────────────────────────

function Stars({ rating }: { rating?: number | null }) {
  const n = rating ?? 0;
  return (
    <span className="flex items-center gap-0.5" aria-label={`${n} stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className={`h-4 w-4 ${i < n ? 'fill-warning text-warning' : 'text-border'}`}
        />
      ))}
    </span>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ReviewsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [deleteSource, setDeleteSource] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset: resetSrc,
    formState: { errors: srcErrors },
  } = useForm<SourceFormValues>({
    resolver: zodResolver(sourceSchema),
    defaultValues: { name: '', placeUrl: '' },
  });

  // ── Queries ──────────────────────────────────────────────────────────────────

  const { data: reviews } = useQuery<Review[]>({
    queryKey: ['marketing', 'reviews'],
    queryFn: () => marketingApi.get('/reviews').then((r) => r.data),
  });

  const { data: sources } = useQuery<Source[]>({
    queryKey: ['marketing', 'reviews', 'sources'],
    queryFn: () => marketingApi.get('/reviews/sources').then((r) => r.data),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'reviews'] });
  const invalidateSrc = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'reviews', 'sources'] });

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const addSource = useMutation({
    mutationFn: (values: SourceFormValues) =>
      marketingApi.post('/reviews/sources', { name: values.name, placeUrl: values.placeUrl }),
    onSuccess: () => {
      resetSrc();
      invalidateSrc();
      toast.success(t('reviews.sourceAdded', 'Source added'));
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('reviews.saveFailed', 'Save failed')),
  });

  const removeSource = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/reviews/sources/${id}`),
    onSuccess: () => { invalidateSrc(); setDeleteSource(null); },
  });

  const draft = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/reviews/${id}/draft`),
    onSuccess: ({ data }, id) => {
      setReplyText((s) => ({ ...s, [id]: data.replyDraft }));
      invalidate();
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('reviews.draftFailed', 'Draft failed')),
  });

  const reply = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      marketingApi.post(`/reviews/${id}/reply`, { text }),
    onSuccess: () => {
      invalidate();
      toast.success(t('reviews.replied', 'Reply saved'));
    },
  });

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('reviews.title', 'Reviews')}
        description={t(
          'reviews.subtitle',
          'Send review requests via automations; happy customers (≥4★) go to your public page, unhappy ones reach you privately first.',
        )}
      />

      {/* Review sources */}
      <Card>
        <CardHeader>
          <CardTitle>{t('reviews.sources', 'Review sources')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            onSubmit={handleSubmit((v) => addSource.mutate(v))}
            className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          >
            <Field error={srcErrors.name?.message}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder={t('reviews.sourceName', 'Name (e.g. Google)')}
                  {...register('name')}
                />
              )}
            </Field>
            <Field error={srcErrors.placeUrl?.message} className="sm:col-span-2">
              {({ id, describedBy, invalid }) => (
                <div className="flex gap-2">
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    placeholder={t('reviews.sourceUrl', 'Google review URL (g.page/r/…)')}
                    {...register('placeUrl')}
                  />
                  <Button type="submit" variant="secondary" loading={addSource.isPending} className="shrink-0">
                    <Plus className="h-4 w-4" />
                    {t('reviews.addSource', 'Add')}
                  </Button>
                </div>
              )}
            </Field>
          </form>

          {(sources ?? []).length > 0 && (
            <Table>
              <TBody>
                {(sources ?? []).map((s) => (
                  <TR key={s.id}>
                    <TD>
                      <span className="font-medium text-foreground">{s.name}</span>
                      {' '}
                      <span className="text-xs text-muted-foreground truncate">{s.placeUrl}</span>
                    </TD>
                    <TD>
                      <div className="flex justify-end">
                        <IconButton
                          aria-label={t('common.delete', 'Delete')}
                          size="sm"
                          variant="ghost"
                          className="text-danger hover:text-danger"
                          onClick={() => setDeleteSource(s.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Reviews */}
      {(reviews ?? []).length === 0 ? (
        <EmptyState
          icon={<Star className="h-10 w-10" />}
          title={t('reviews.empty', 'No reviews yet')}
          description={t('reviews.emptyDesc', 'Add a source and send review requests from an automation.')}
        />
      ) : (
        <div className="space-y-3">
          {(reviews ?? []).map((r) => (
            <Card key={r.id}>
              <CardContent className="pt-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Stars rating={r.rating} />
                    <Badge tone={reviewStatusTone(r.status)}>
                      {reviewStatusLabel(r.status, t)}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </div>

                {r.text && (
                  <p className="text-sm text-foreground">{r.text}</p>
                )}

                {r.replyText ? (
                  <div className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
                    {t('reviews.yourReply', 'Your reply')}: {r.replyText}
                  </div>
                ) : (
                  (r.status === 'PRIVATE_FEEDBACK' || r.status === 'PUBLIC_ROUTED') && (
                    <div className="space-y-2">
                      <Textarea
                        value={replyText[r.id] ?? r.replyDraft ?? ''}
                        onChange={(e) =>
                          setReplyText((s) => ({ ...s, [r.id]: e.target.value }))
                        }
                        className="min-h-20"
                        placeholder={t('reviews.replyPlaceholder', 'Write a reply…')}
                      />
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => draft.mutate(r.id)}
                          disabled={draft.isPending}
                          loading={draft.isPending}
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          {t('reviews.aiDraft', 'AI draft')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() =>
                            reply.mutate({ id: r.id, text: replyText[r.id] ?? r.replyDraft ?? '' })
                          }
                          disabled={!(replyText[r.id] ?? r.replyDraft) || reply.isPending}
                          loading={reply.isPending}
                        >
                          {t('reviews.saveReply', 'Save reply')}
                        </Button>
                      </div>
                    </div>
                  )
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Delete source confirm */}
      <ConfirmDialog
        open={!!deleteSource}
        onOpenChange={(open) => { if (!open) setDeleteSource(null); }}
        title={t('reviews.deleteSourceTitle', 'Delete review source?')}
        description={t('reviews.deleteSourceDesc', 'This action cannot be undone.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        onConfirm={() => deleteSource && removeSource.mutate(deleteSource)}
        loading={removeSource.isPending}
      />
    </div>
  );
}
