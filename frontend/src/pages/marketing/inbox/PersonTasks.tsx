import { useTranslation } from 'react-i18next';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Skeleton } from '@/components/ui/Skeleton';
import { useLeadTaskActions } from '../../../features/marketing/hooks/useLeadRecordActions';
import { fmtDate } from '../../../features/marketing/utils/format';
import TasksTab from '../leadDetail/TasksTab';
import { usePersonRecord } from './usePersonRecord';

export interface PersonTasksProps {
  /** Whose tasks. The record card owns the identity; this section owns the read. */
  leadId: string;
}

/**
 * `GÖREVLER` — the person's tasks, as a section of their record card.
 *
 * It renders `TasksTab` — the SAME component the lead detail's Görevler tab
 * renders, in `embedded` chrome — and drives it with the same
 * `useLeadTaskActions` writes. That is the point of the whole stage: a second
 * implementation of "this person's tasks" is the "which one is right?" cost
 * this line of work exists to remove, and the two would drift first on the
 * things nobody re-reads (which queries get invalidated, whether a completed
 * task can be deleted).
 *
 * What is NOT shared is the loading and error state, and that is deliberate.
 * `TasksTab` only ever renders a settled, successful answer; this container
 * owns the query, so it owns the difference between "no tasks" and "could not
 * read them". On the detail page those two states belong to the page; here
 * they belong to one section of five, and a section that blanks or lies would
 * take a whole card down with it.
 */
export function PersonTasks({ leadId }: PersonTasksProps) {
  const { t } = useTranslation('marketing');
  const record = usePersonRecord(leadId);
  const actions = useLeadTaskActions(leadId);

  return (
    <section className="space-y-2 border-t border-border pt-3">
      {/* The heading lives inside TasksTab's embedded chrome on the success
          path; on the failure path the boundary's own sentence carries the
          section's NAME, so a broken section is still identifiable. */}
      <QueryStateBoundary
        isLoading={record.isLoading}
        isError={record.isError}
        onRetry={() => record.refetch()}
        errorMessage={t('surface.tasks.failed', 'Görevler yüklenemedi.')}
        retryLabel={t('common.retry', 'Tekrar dene')}
        loading={<Skeleton className="h-12 rounded-md" />}
        className="py-4"
      >
        <TasksTab
          embedded
          leadId={leadId}
          tasks={record.data?.tasks ?? []}
          fmtDate={fmtDate}
          onCreate={(data) => actions.create.mutate(data)}
          createPending={actions.create.isPending}
          onComplete={(taskId) => actions.complete.mutate(taskId)}
          onDelete={(taskId) => actions.remove.mutate(taskId)}
        />
      </QueryStateBoundary>
    </section>
  );
}
