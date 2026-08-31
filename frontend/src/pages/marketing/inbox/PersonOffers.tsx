import { useTranslation } from 'react-i18next';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Skeleton } from '@/components/ui/Skeleton';
import { useLeadOfferActions } from '../../../features/marketing/hooks/useLeadRecordActions';
import { fmtDate } from '../../../features/marketing/utils/format';
import OffersTab from '../leadDetail/OffersTab';
import { usePersonRecord } from './usePersonRecord';

export interface PersonOffersProps {
  /** Whose offers. The record card owns the identity; this section owns the read. */
  leadId: string;
}

/**
 * `TEKLİFLER` — the person's offers, as a section of their record card.
 *
 * Renders `OffersTab` in `embedded` chrome — the SAME component the lead
 * detail's Teklifler tab renders — driven by the same `useLeadOfferActions`
 * writes. See `PersonTasks` for why a second copy was not an option.
 *
 * `converted` comes from the fetched record rather than from the card's
 * `lead` prop, and that matters: the prop is the row the LIST returned, which
 * has no `convertedTenantId`. Reading it from there would have hidden "new
 * offer" from nobody — `undefined` is falsy — and quietly offered a new quote
 * on a contact who is already a paying tenant. The detail read carries the
 * field, so the two surfaces refuse in the same case.
 *
 * The loading and error states are the container's, not the tab's: `OffersTab`
 * only ever renders a settled, successful answer, so "no offers" and "could
 * not read them" cannot collapse into one screen.
 */
export function PersonOffers({ leadId }: PersonOffersProps) {
  const { t } = useTranslation('marketing');
  const record = usePersonRecord(leadId);
  const actions = useLeadOfferActions(leadId);

  return (
    <section className="space-y-2 border-t border-border pt-3">
      <QueryStateBoundary
        isLoading={record.isLoading}
        isError={record.isError}
        onRetry={() => record.refetch()}
        errorMessage={t('surface.offers.failed', 'Teklifler yüklenemedi.')}
        retryLabel={t('common.retry', 'Tekrar dene')}
        loading={<Skeleton className="h-12 rounded-md" />}
        className="py-4"
      >
        <OffersTab
          embedded
          leadId={leadId}
          offers={record.data?.offers ?? []}
          converted={!!record.data?.convertedTenantId}
          fmtDate={fmtDate}
          onCreate={(data) => actions.create.mutate(data)}
          createPending={actions.create.isPending}
          onSend={(offerId) => actions.send.mutate(offerId)}
          onDelete={(offerId) => actions.remove.mutate(offerId)}
        />
      </QueryStateBoundary>
    </section>
  );
}
