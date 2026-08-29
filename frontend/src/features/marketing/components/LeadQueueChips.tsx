import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { listLeads, type LeadListParams } from '../api/leads.service';

/**
 * The three named work queues over the person list, in the spec's order.
 *
 * This file exists because there are now TWO surfaces that offer them — the
 * person-primary surface's list column and the leads table — and the chips are
 * the one part of v2.283.0 the owner signed off on. `Bekleyen` in particular
 * has to keep meaning exactly what the morning digest means; a second copy of
 * this map is how that definition forks without anybody noticing.
 */
export type LeadQueue = 'waiting' | 'unassigned' | 'all';

export const LEAD_QUEUE_PARAMS: Record<
  LeadQueue,
  Pick<LeadListParams, 'assignmentStatus' | 'waitingReply'>
> = {
  waiting: { waitingReply: true },
  unassigned: { assignmentStatus: 'unassigned' },
  all: {},
};

/** The filters a queue count is measured UNDER — everything except the queue. */
export type LeadQueueBase = Pick<
  LeadListParams,
  'search' | 'status' | 'source' | 'businessType'
>;

export interface LeadQueueCount {
  data?: number;
  isError: boolean;
}

/**
 * How many leads one queue would show under the CURRENT other filters — the
 * number on the chip is what you get when you click it.
 *
 * The queue you are already IN is never probed: the list query has just counted
 * exactly that set, so a second count is only one more number that can disagree
 * with the rows on screen. The caller passes that one in as `activeTotal`.
 */
function useQueueCount(base: LeadQueueBase, queue: LeadQueue, active: LeadQueue | null) {
  return useQuery({
    queryKey: ['marketing', 'leads', 'queue-count', queue, base],
    queryFn: () =>
      listLeads({ ...base, ...LEAD_QUEUE_PARAMS[queue], page: 1, limit: 1 }).then(
        (r) => r.meta.total,
      ),
    enabled: queue !== active,
    staleTime: 30_000,
  });
}

/** All three counts, keyed by queue. One hook so a caller cannot probe two and
 *  forget the third. */
export function useLeadQueueCounts(
  base: LeadQueueBase,
  active: LeadQueue | null,
): Record<LeadQueue, LeadQueueCount> {
  return {
    waiting: useQueueCount(base, 'waiting', active),
    unassigned: useQueueCount(base, 'unassigned', active),
    all: useQueueCount(base, 'all', active),
  };
}

/**
 * The number on a work-queue chip.
 *
 * Three states, and they must not read alike. A count we HAVE is the number; a
 * count we could not fetch is an em dash that says so when you hover or ask a
 * screen reader; a count still in flight is nothing at all. Rendering a failed
 * count as `0` would announce an empty queue when nobody knows whether it is
 * empty — the same "a failed query and no results look identical" bug this repo
 * already paid for in the morning brief.
 */
function QueueCount({
  total,
  isError,
  failedLabel,
}: {
  total?: number;
  isError?: boolean;
  failedLabel: string;
}) {
  if (isError)
    return (
      <span title={failedLabel} aria-label={failedLabel}>
        —
      </span>
    );
  if (typeof total !== 'number') return null;
  return <span>{total}</span>;
}

export interface LeadQueueChipsProps {
  /** Null when the current filters describe none of the three — which is the
   *  truth (e.g. "assigned to me"), not a bug, and lights no chip. */
  active: LeadQueue | null;
  counts: Record<LeadQueue, LeadQueueCount>;
  /** The ACTIVE queue's total, read off the list query rather than re-counted. */
  activeTotal?: number;
  onSelect: (queue: LeadQueue) => void;
  className?: string;
}

/**
 * `Bekleyen` / `Atanmamış` / `Hepsi`, with counts.
 *
 * `Hepsi` is the one that matters for the merged surface: it includes the
 * people who have never had a conversation. Sorting by last activity pushes
 * them to the bottom of the list, and these chips — not the sort — are what
 * bring them back.
 */
export function LeadQueueChips({
  active,
  counts,
  activeTotal,
  onSelect,
  className,
}: LeadQueueChipsProps) {
  const { t } = useTranslation('marketing');

  return (
    <div
      role="group"
      aria-label={t('leads.queue.label', { defaultValue: 'İş kuyruğu' })}
      className={className ?? 'flex flex-wrap items-center gap-2'}
    >
      {(
        [
          [
            'waiting',
            t('leads.queue.waiting', { defaultValue: 'Bekleyen' }),
            t('leads.queue.waitingHint', {
              defaultValue: 'Müşteri en son yazan taraf ve kimse yanıtlamadı',
            }),
          ],
          ['unassigned', t('leads.queue.unassigned', { defaultValue: 'Atanmamış' }), undefined],
          ['all', t('leads.queue.all', { defaultValue: 'Hepsi' }), undefined],
        ] as const
      ).map(([queue, label, hint]) => (
        <Button
          key={queue}
          size="sm"
          variant={active === queue ? 'primary' : 'outline'}
          aria-pressed={active === queue}
          title={hint}
          onClick={() => onSelect(queue)}
        >
          {label}
          {/* An explicit space, not just the flex gap: the accessible name is
              built from text nodes, and without it a screen reader announces
              "Bekleyen2". */}
          {' '}
          <QueueCount
            total={active === queue ? activeTotal : counts[queue].data}
            isError={active !== queue && counts[queue].isError}
            failedLabel={t('leads.queue.countFailed', { defaultValue: 'Sayı alınamadı' })}
          />
        </Button>
      ))}
    </div>
  );
}
