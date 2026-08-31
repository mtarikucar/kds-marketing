import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Skeleton } from '@/components/ui/Skeleton';
import { listEstimates } from '../../../features/marketing/api/estimates.service';
import { fmtDate } from '../../../features/marketing/utils/format';
import { formatMoney } from '../../../lib/money';

const statusTone: Record<string, BadgeProps['tone']> = {
  DRAFT: 'neutral',
  SENT: 'info',
  ACCEPTED: 'success',
  DECLINED: 'danger',
  EXPIRED: 'warning',
};

export interface PersonEstimatesProps {
  /** Whose quotes. */
  leadId: string;
}

/**
 * `TAHMİNİ FİYAT` — the person's estimates, as a section of their record card.
 *
 * Mounted only while its disclosure is open (see `RecordDisclosure`), so a rep
 * clicking through a queue never pays for this read.
 *
 * ## Why this one is a READ and the two above it are not
 *
 * `Estimate` has no per-lead component to reuse: `/estimates` is a single
 * 629-line page whose editor is a line-item table with per-line tax rates and a
 * live minor-unit total. There is nothing to embed, and rebuilding that editor
 * into a 26%-wide column would be exactly the second implementation this stage
 * exists to avoid — with money arithmetic as the thing that drifts. So the card
 * ANSWERS the question ("has this person been quoted, for how much, and did
 * they accept?") and `/estimates` keeps the editing. The route is untouched and
 * nothing is lost; what changed is that the answer is now beside the person.
 *
 * Totals are MINOR units on the wire (kuruş/cents), matching invoices.
 */
export function PersonEstimates({ leadId }: PersonEstimatesProps) {
  const { t } = useTranslation('marketing');

  const query = useQuery({
    queryKey: ['marketing', 'estimates', 'lead', leadId],
    queryFn: () => listEstimates({ leadId }),
  });

  const estimates = query.data ?? [];

  return (
    <QueryStateBoundary
      isLoading={query.isLoading}
      isError={query.isError}
      onRetry={() => query.refetch()}
      errorMessage={t('surface.estimates.failed', 'Tahmini fiyatlar yüklenemedi.')}
      retryLabel={t('common.retry', 'Tekrar dene')}
      loading={<Skeleton className="h-12 rounded-md" />}
      className="py-4"
    >
      {estimates.length > 0 ? (
        <ul className="space-y-2">
          {estimates.map((e) => (
            <li
              key={e.id}
              data-testid={`estimate-${e.id}`}
              className="space-y-1 rounded-md border border-border p-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-foreground">
                  {e.number}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-foreground">
                  {formatMoney((e.total || 0) / 100, e.currency)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <Badge tone={statusTone[e.status] ?? 'neutral'} size="sm">
                  {e.status}
                </Badge>
                {/* An absent expiry says so rather than leaving a blank that a
                    hurried eye reads as "today". Same rule as the SATIŞ
                    section's close date. */}
                <span className="truncate">
                  {e.validUntil
                    ? fmtDate(e.validUntil)
                    : t('surface.estimates.noExpiry', 'Geçerlilik tarihi yok')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        // A settled, successful, EMPTY answer — never the same screen as the
        // boundary's failure sentence above.
        <p data-testid="estimates-empty" className="text-[11px] text-muted-foreground">
          {t('surface.estimates.none', 'Bu kişiye tahmini fiyat verilmemiş.')}
        </p>
      )}
    </QueryStateBoundary>
  );
}
