import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Film, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import {
  getBatch,
  regenerateKeyframe,
  requestStoryboard,
  type ConceptRow,
  type Shot,
} from '../../../features/marketing/api/contentLine.service';

/** A frame the vendor is still drawing — the reason the detail keeps polling. */
const isPending = (sh: Shot) => sh.keyframe?.status === 'QUEUED' || sh.keyframe?.status === 'GENERATING';
const isFailed = (sh: Shot) => sh.keyframe?.status === 'FAILED' || sh.keyframe?.status === 'BLOCKED';

/** Only a PROPOSED concept, or an approved one not yet handed to production,
 *  may still have frames drawn or redrawn here; after that the campaign item
 *  owns them. Mirrors `StoryboardService.eligible`. */
const canStoryboard = (c: ConceptRow) =>
  c.status === 'PROPOSED' || (c.status === 'APPROVED' && !c.promotedItemId);

const POLL_MS = 10_000;

/**
 * ONE BATCH, opened: the concepts that came out of a single idea, each with the
 * angle it takes, the hook it opens on, WHY it is in the batch — and, since
 * storyboards, WHAT IT WILL LOOK LIKE: one still per beat, drawn on request
 * before anyone approves, redrawable one at a time, and animated as the first
 * frame of each clip once the concept is approved.
 *
 * `selectionReason` is the auditability half of the learning loop. A line that
 * weights itself toward what already worked is only trustworthy while it keeps
 * saying so; once "these five" stops being explainable, the bias is invisible
 * and unarguable. A null reason is not a gap — it means the batch was planned
 * cold, with nothing measured to lean on, and saying that plainly is the point.
 *
 * Approval itself stays where it was (the review tool); this screen shows the
 * frames and the price a reviewer approves, it does not approve.
 */
export function BatchDetail({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const key = ['marketing', 'content-line', 'batch', batchId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => getBatch(batchId),
    meta: { skipErrorToast: true },
    // Frames render in the background; while any is in flight the row is
    // re-read so the picture lands without a reload.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((c) => c.shotPlan?.shots?.some(isPending)) ? POLL_MS : false,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['marketing', 'content-line', 'batches'] });
  };
  const storyboard = useMutation({
    mutationFn: (conceptId: string) => requestStoryboard(conceptId),
    onSuccess: invalidate,
    onError: () => toast.error(t('contentLine.detail.actionError', 'Storyboard isteği başarısız oldu.')),
  });
  const redraw = useMutation({
    mutationFn: ({ conceptId, ord }: { conceptId: string; ord: number }) => regenerateKeyframe(conceptId, ord),
    onSuccess: invalidate,
    onError: () => toast.error(t('contentLine.detail.actionError', 'Storyboard isteği başarısız oldu.')),
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t('contentLine.detail.title', 'Bu fikirden çıkan konseptler')}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('common.close', 'Kapat')}>
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <QueryStateBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          onRetry={() => void q.refetch()}
          errorMessage={t('contentLine.detail.error', 'Konseptler okunamadı.')}
        >
          <ul className="space-y-3">
            {(q.data ?? []).map((c) => {
              const plan = c.shotPlan;
              const shots = plan?.shots ?? [];
              const production = plan?.production;
              const hasFrames = shots.some((sh) => sh.keyframe);
              const pending = shots.some(isPending);
              const busy = storyboard.isPending && storyboard.variables === c.id;
              return (
                <li key={c.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral">{c.angle}</Badge>
                    <span className="text-sm font-medium">{c.title}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{c.hook}</p>
                  {c.rationale && <p className="mt-1 text-xs text-muted-foreground">{c.rationale}</p>}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {c.selectionReason ??
                      t(
                        'contentLine.detail.coldReason',
                        'Ölçülecek geçmiş yoktu — bu parti tarafsız planlandı.',
                      )}
                  </p>

                  {production && (
                    <p className="mt-2 text-xs" data-testid="concept-quote">
                      {production.keyframes
                        ? t('contentLine.detail.quote', '{{credits}} kredi · {{frames}} kare + {{sec}} sn video', {
                            credits: production.credits,
                            frames: shots.length,
                            sec: production.billedSec,
                          })
                        : t('contentLine.detail.quoteNoFrames', '{{credits}} kredi · {{sec}} sn video (kare planı yok)', {
                            credits: production.credits,
                            sec: production.billedSec,
                          })}
                    </p>
                  )}

                  {/* THE STORYBOARD. One tile per beat: the frame when READY, its
                      state otherwise. Present on every plan made since frames
                      existed; a legacy plan says so instead of showing nothing. */}
                  <div className="mt-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1 text-xs font-medium">
                        <Film className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('contentLine.detail.storyboardTitle', 'Storyboard')}
                      </span>
                      {plan?.storyboard && canStoryboard(c) && !hasFrames && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => storyboard.mutate(c.id)}
                        >
                          {busy
                            ? t('contentLine.detail.making', 'Kareler çiziliyor…')
                            : t('contentLine.detail.make', 'Storyboard oluştur')}
                        </Button>
                      )}
                    </div>
                    {!plan?.storyboard ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t(
                          'contentLine.detail.legacy',
                          "Bu konsept storyboard'dan önce planlandı; kareleri görmek için fikri yeniden planla.",
                        )}
                      </p>
                    ) : (
                      <ol className="mt-2 flex gap-2 overflow-x-auto" aria-label={t('contentLine.detail.storyboardTitle', 'Storyboard')}>
                        {shots.map((sh) => (
                          <li key={sh.ord} className="w-28 shrink-0" data-testid={`frame-${sh.ord}`}>
                            <div className="flex aspect-[9/16] items-center justify-center overflow-hidden rounded-md border bg-muted">
                              {sh.keyframe?.status === 'READY' && sh.keyframe.url ? (
                                <img src={sh.keyframe.url} alt={sh.scene} className="h-full w-full object-cover" />
                              ) : isPending(sh) ? (
                                <span className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground">
                                  <Spinner className="h-4 w-4" />
                                  {t('contentLine.detail.framePending', 'çiziliyor')}
                                </span>
                              ) : isFailed(sh) ? (
                                <span
                                  className="flex flex-col items-center gap-1 px-1 text-center text-[11px] text-destructive"
                                  title={sh.keyframe?.error}
                                >
                                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                                  {t('contentLine.detail.frameFailed', 'çizilemedi')}
                                </span>
                              ) : (
                                <span className="text-[11px] text-muted-foreground">
                                  {t('contentLine.detail.frameNone', 'kare yok')}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 truncate text-[11px]" title={sh.description ?? sh.prompt}>
                              {sh.scene} · {t('contentLine.detail.seconds', '{{n}} sn', { n: sh.durationSec })}
                            </p>
                            {sh.onScreenText && (
                              <p className="truncate text-[11px] text-muted-foreground" title={sh.onScreenText}>
                                {sh.onScreenText}
                              </p>
                            )}
                            {canStoryboard(c) && sh.keyframe && !isPending(sh) && (
                              <button
                                type="button"
                                className="mt-1 flex items-center gap-1 text-[11px] text-primary hover:underline disabled:opacity-50"
                                disabled={redraw.isPending}
                                onClick={() => redraw.mutate({ conceptId: c.id, ord: sh.ord })}
                                aria-label={`${t('contentLine.detail.regenerate', 'Yeniden üret')} ${sh.scene}`}
                              >
                                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                                {t('contentLine.detail.regenerate', 'Yeniden üret')}
                              </button>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                    {plan?.storyboard && !canStoryboard(c) && c.promotedItemId && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('contentLine.detail.inProduction', 'Üretimde — kareler ve klipler kampanya öğesinde.')}
                      </p>
                    )}
                    {pending && <span className="sr-only">{t('contentLine.detail.making', 'Kareler çiziliyor…')}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </QueryStateBoundary>
      </div>
    </div>
  );
}
