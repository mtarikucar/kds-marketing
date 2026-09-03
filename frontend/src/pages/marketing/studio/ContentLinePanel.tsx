import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { LearnedPanel } from './LearnedPanel';
import { BatchCard } from './BatchCard';
import {
  listBatches,
  planConcepts,
  getAnglePerformance,
} from '../../../features/marketing/api/contentLine.service';

/**
 * THE CONTENT LINE, as one panel: paste an idea, see what the line has learned,
 * and watch every batch's life from proposal to published.
 *
 * Sits as the second tab of the studio's left column, beside the strategy ideas
 * backlog. Tabbed rather than stacked because the one-screen's area allocation
 * is argued, not incidental — the ideas panel grew to exactly what the stats
 * band gave up — and a third stacked region would take that back by having more
 * to say. The same trade the home screen already makes for Takvim ⋮ Akış.
 *
 * The two queries are SEPARATE on purpose. If angle history breaks, the batch
 * cards still arrive and the missing panel names itself; one combined query
 * would let a single broken read empty the whole studio.
 */
export function ContentLinePanel({ onOpenBatch }: { onOpenBatch: (batchId: string) => void }) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [idea, setIdea] = useState('');

  const batches = useQuery({
    queryKey: ['marketing', 'content-line', 'batches'],
    queryFn: () => listBatches(),
    meta: { skipErrorToast: true },
  });

  // Read from the same key `LearnedPanel` uses, so this is served from its cache
  // rather than firing a second identical request. Needed here only to decide
  // whether the composer can offer a weight override at all.
  const angles = useQuery({
    queryKey: ['marketing', 'content-line', 'angles'],
    queryFn: getAnglePerformance,
    meta: { skipErrorToast: true },
  });

  const plan = useMutation({
    mutationFn: () => planConcepts({ idea: idea.trim() }),
    onSuccess: (res) => {
      setIdea('');
      void qc.invalidateQueries({ queryKey: ['marketing', 'content-line'] });
      toast.success(
        res.cold
          ? t(
              'contentLine.planned.cold',
              '{{n}} konsept üretildi. Ölçülecek geçmiş olmadığı için tarafsız planlandı.',
              { n: res.concepts.length },
            )
          : t('contentLine.planned.guided', '{{n}} konsept üretildi.', {
              n: res.concepts.length,
            }),
      );
      onOpenBatch(res.batchId);
    },
    onError: (e: unknown) => {
      // Named, not swallowed: planning spends credits, and a silent failure here
      // is indistinguishable from "the model had nothing to say".
      toast.error(
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          t('contentLine.planned.error', 'Konseptler üretilemedi.'),
      );
    },
  });

  const canPlan = idea.trim().length > 0 && !plan.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="space-y-2">
        <label htmlFor="content-line-idea" className="text-sm font-semibold">
          {t('contentLine.composer.label', 'Bir fikir yapıştır')}
        </label>
        <textarea
          id="content-line-idea"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={3}
          placeholder={t(
            'contentLine.composer.placeholder',
            'Ürün, olay ya da gözlem — birkaç cümle yeter. Farklı açılardan konseptlere bölünecek.',
          )}
          className="w-full resize-y rounded-md border bg-background p-2 text-sm"
        />
        <div className="flex items-center gap-2">
          <Button onClick={() => plan.mutate()} disabled={!canPlan}>
            <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {plan.isPending
              ? t('contentLine.composer.working', 'Üretiliyor…')
              : t('contentLine.composer.submit', 'Konsept üret')}
          </Button>
          {angles.data && !angles.data.cold && (
            <span className="text-xs text-muted-foreground">
              {t(
                'contentLine.composer.guided',
                'Ölçülen açılara göre ağırlıklandırılacak, bir slot keşfe ayrılacak.',
              )}
            </span>
          )}
        </div>
      </div>

      <LearnedPanel />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <QueryStateBoundary
          isLoading={batches.isLoading}
          isError={batches.isError}
          onRetry={() => void batches.refetch()}
          errorMessage={t('contentLine.batches.error', 'Partiler okunamadı.')}
        >
          {(batches.data?.length ?? 0) === 0 ? (
            <EmptyState
              title={t('contentLine.batches.emptyTitle', 'Henüz parti yok')}
              description={t(
                'contentLine.batches.emptyBody',
                'Yukarıya bir fikir yapıştır; birbirinden farklı açılarda konseptlere bölünsün.',
              )}
            />
          ) : (
            <ul className="space-y-2">
              {(batches.data ?? []).map((b) => (
                <BatchCard key={b.batchId} batch={b} onOpen={onOpenBatch} />
              ))}
            </ul>
          )}
        </QueryStateBoundary>
      </div>
    </div>
  );
}
