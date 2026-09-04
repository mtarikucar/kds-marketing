import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { getBatch } from '../../../features/marketing/api/contentLine.service';

interface Concept {
  id: string;
  angle: string;
  hook: string;
  title: string;
  rationale: string | null;
  status: string;
  selectionReason: string | null;
}

/**
 * ONE BATCH, opened: the concepts that came out of a single idea, each with the
 * angle it takes, the hook it opens on, and — the reason this screen exists —
 * WHY it is in the batch.
 *
 * `selectionReason` is the auditability half of the learning loop. A line that
 * weights itself toward what already worked is only trustworthy while it keeps
 * saying so; once "these five" stops being explainable, the bias is invisible
 * and unarguable. A null reason is not a gap — it means the batch was planned
 * cold, with nothing measured to lean on, and saying that plainly is the point.
 */
export function BatchDetail({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const { t } = useTranslation('marketing');
  const q = useQuery({
    queryKey: ['marketing', 'content-line', 'batch', batchId],
    queryFn: () => getBatch(batchId) as Promise<Concept[]>,
    meta: { skipErrorToast: true },
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
            {(q.data ?? []).map((c) => (
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
              </li>
            ))}
          </ul>
        </QueryStateBoundary>
      </div>
    </div>
  );
}
