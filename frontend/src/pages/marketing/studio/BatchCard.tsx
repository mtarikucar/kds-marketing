import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import type { BatchSummary } from '../../../features/marketing/api/contentLine.service';

/**
 * ONE IDEA'S WHOLE LIFE, on one card: how many concepts it produced, how many a
 * human has looked at, what is being made, what went out, and what it earned.
 *
 * `ContentConcept.batchId` has grouped "these N came from that one idea" since
 * the concept machinery shipped and appeared NOWHERE in the frontend — the
 * grouping existed in the database and in the chat, and a fikir's life was
 * spread across five surfaces. This card is the join made visible.
 *
 * It is a BRANCHING POINT, not a second implementation. It renders counts and
 * links; the concepts, the campaign items, the calendar and the reports all keep
 * their own surfaces and are reached from here. Re-rendering any of them inside
 * this card would be the mistake the lead merge already paid for once.
 */
export function BatchCard({
  batch,
  onOpen,
}: {
  batch: BatchSummary;
  onOpen: (batchId: string) => void;
}) {
  const { t } = useTranslation('marketing');
  const p = batch.production;
  const inFlight = p.generating + p.needsApproval + p.scheduled;

  return (
    <li className="rounded-lg border p-3">
      <button
        type="button"
        onClick={() => onOpen(batch.batchId)}
        className="flex w-full items-start gap-2 text-left"
      >
        <span className="min-w-0 flex-1">
          {/* The card's title is the ask itself, verbatim — a reviewer judges a
              batch against what was actually pasted, not against a summary of
              it. Clamped rather than truncated so a two-line idea still reads. */}
          <span className="line-clamp-2 text-sm font-medium">{batch.sourceIdea}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t('contentLine.card.concepts', '{{count}} konsept', {
              count: batch.concepts.total,
            })}
            {' · '}
            {new Date(batch.createdAt).toLocaleDateString()}
          </span>
        </span>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {batch.concepts.awaitingReview > 0 && (
          <Badge tone="neutral">
            {t('contentLine.card.awaiting', '{{count}} onay bekliyor', {
              count: batch.concepts.awaitingReview,
            })}
          </Badge>
        )}
        {p.generating > 0 && (
          <Badge tone="neutral">
            {t('contentLine.card.generating', '{{count}} üretimde', { count: p.generating })}
          </Badge>
        )}
        {p.needsApproval > 0 && (
          <Badge tone="neutral">
            {t('contentLine.card.needsApproval', '{{count}} yayın onayı bekliyor', {
              count: p.needsApproval,
            })}
          </Badge>
        )}
        {p.scheduled > 0 && (
          <Badge tone="neutral">
            {t('contentLine.card.scheduled', '{{count}} planlandı', { count: p.scheduled })}
          </Badge>
        )}
        {p.published > 0 && (
          <Badge tone="success">{t('contentLine.card.published', '{{count}} yayında', { count: p.published })}</Badge>
        )}
        {p.failed > 0 && (
          <Badge tone="danger">
            {t('contentLine.card.failed', '{{count}} başarısız', { count: p.failed })}
          </Badge>
        )}

        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {/*
            null is NOT zero. A batch that has published nothing has not been
            measured; printing "0 erişim" on it reports a failure that has not
            happened yet.
          */}
          {batch.reach === null
            ? t('contentLine.card.notPublished', 'yayınlanmadı')
            : t('contentLine.card.reach', '{{n}} erişim', {
                n: batch.reach.toLocaleString(),
              })}
        </span>
      </div>

      {inFlight > 0 && (
        <Link
          to="/social-campaigns"
          className="mt-2 inline-block text-xs text-primary hover:underline"
        >
          {t('contentLine.card.toCampaigns', 'Üretimi kampanyalarda aç')}
        </Link>
      )}
    </li>
  );
}
