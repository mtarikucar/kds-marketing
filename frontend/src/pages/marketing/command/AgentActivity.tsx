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
export const isNewsworthy = (r: AgentRun) => Boolean(r.goal) || r.toolCalls.length > 0;

/** How many runs this panel will draw. A constant rather than a prop: the flow
 *  tab's failure badge counts over the SAME window, and a caller that could
 *  shrink the window here would silently re-open the gap between them. */
export const ACTIVITY_LIMIT = 8;

/**
 * Which runs this panel draws, in order. The failure badge on the flow tab
 * calls this too, so "what is on screen" has exactly one definition. Both the
 * newsworthiness filter AND the cap belong to it: the backend's list() takes 50
 * with no time window, so past a workspace's first day the cap is the normal
 * case, not an edge one. A badge counting over 50 while the panel draws 8 stays
 * lit over a failure the tab cannot show — decoration, not signal.
 */
export const selectActivityRuns = (runs: AgentRun[]) =>
  runs.filter(isNewsworthy).slice(0, ACTIVITY_LIMIT);

/**
 * Did this run go wrong, in the sense the operator cares about?
 *
 * Two discriminators, because there are two ways for work to be lost and only
 * one of them sets `status`:
 *
 *   - `status === 'FAILED'` — the run itself died, often before it got a single
 *     tool call off (e.g. "AI is not configured").
 *   - any tool call with `ok === false` — the run RAN TO COMPLETION but part of
 *     what it tried did not land. The command loop hands a broker failure back
 *     to the model as `{ error }` and lets it carry on, so the run finishes
 *     'DONE' while the tool call was already written `ok: false`. Judging on
 *     status alone paints that green, and a swallowed tool failure is exactly
 *     the kind of quiet loss the home screen exists to make loud.
 *
 * Per RUN, not per call: this answers "how many things should I go look at".
 */
export const isFailedRun = (r: AgentRun) =>
  r.status === 'FAILED' || r.toolCalls.some((c) => !c.ok);

/**
 * What the agent has actually been doing, newest first.
 *
 * This is the honest counterpart to the command bar's prose: it reads the
 * AgentRun/ToolCallLog audit trail, so a run that failed or was refused shows
 * up here exactly as it happened. The point of the home screen is that the
 * owner can trust the system was working without asking it — that only holds
 * if failures are as visible as successes.
 */
export function AgentActivity() {
  const { t } = useTranslation('marketing');
  const q = useQuery({ queryKey: ['agent-runs'], queryFn: listAgentRuns });
  const runs: AgentRun[] = selectActivityRuns(q.data ?? []);

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
            const failed = isFailedRun(r);
            const running = r.status === 'RUNNING';
            const okCalls = r.toolCalls.filter((c: AgentRunToolCall) => c.ok).length;
            return (
              <li
                key={r.id}
                // The verdict, not the icon. `data-failed` is what the badge is
                // held to in tests — a Tailwind retune or an icon swap must not
                // read as a change in whether this run went wrong.
                data-testid={`run-${r.id}`}
                data-failed={failed ? 'true' : 'false'}
                className="flex items-start gap-2.5 py-2.5"
              >
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
