import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import {
  listAgentRuns,
  type AgentRun,
  type AgentRunToolCall,
} from '../../../features/marketing/api/command.service';
import { fmtDateTime } from '../../../features/marketing/utils/format';

/** A run is worth a line only if it says what it DID. A goal-less run with no
 *  tool calls is bookkeeping, not news. */
const isNewsworthy = (r: AgentRun) => Boolean(r.goal) || r.toolCalls.length > 0;

/**
 * What the agent has actually been doing, newest first.
 *
 * This is the honest counterpart to the command bar's prose: it reads the
 * AgentRun/ToolCallLog audit trail, so a run that failed or was refused shows
 * up here exactly as it happened. The point of the home screen is that the
 * owner can trust the system was working without asking it — that only holds
 * if failures are as visible as successes.
 */
export function AgentActivity({ limit = 8 }: { limit?: number }) {
  const { t } = useTranslation('marketing');
  const q = useQuery({ queryKey: ['agent-runs'], queryFn: listAgentRuns });
  const runs: AgentRun[] = (q.data ?? []).filter(isNewsworthy).slice(0, limit);

  return (
    <QueryStateBoundary isLoading={q.isLoading} isError={q.isError} onRetry={() => q.refetch()}>
      {runs.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 className="h-5 w-5" />}
          title={t('activity.none.title', 'Henüz bir iş yapılmadı')}
          description={t(
            'activity.none.desc',
            'Ajan bir şey yaptığında — gönderi, araştırma, takip — burada görürsün.',
          )}
        />
      ) : (
        <ul className="divide-y divide-border">
          {runs.map((r) => {
            const failed = r.status === 'FAILED';
            const running = r.status === 'RUNNING';
            const okCalls = r.toolCalls.filter((c: AgentRunToolCall) => c.ok).length;
            return (
              <li key={r.id} className="flex items-start gap-2.5 py-2.5">
                {running ? (
                  <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                ) : failed ? (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">
                    {r.goal || t(`activity.agent.${r.agent}`, r.agent)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {fmtDateTime(r.startedAt)}
                    {r.toolCalls.length > 0 && ` · ${okCalls}/${r.toolCalls.length} işlem`}
                    {failed && r.error && ` · ${r.error}`}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </QueryStateBoundary>
  );
}
