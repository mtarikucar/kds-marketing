import { useQuery } from '@tanstack/react-query';
import {
  listAgentRuns,
  type AgentRun,
} from '../../../features/marketing/api/command.service';
import { isNewsworthy } from './AgentActivity';

/**
 * What counts as a failure the owner has not seen yet.
 *
 * Two discriminators, because the audit trail has two ways to go wrong and
 * `AgentActivity` draws BOTH in red:
 *
 *   - `status === 'FAILED'` — the run itself died (often before it got a single
 *     tool call off, e.g. "AI is not configured"). Counting only tool calls
 *     would leave this one unbadged while the tab shows it with a red X.
 *   - a tool call with `ok === false` — the run finished, but part of what it
 *     tried did not land. The panel prints this as "1/2 işlem"; nothing else on
 *     the home screen would tell you.
 *
 * Counted per RUN, not per call: the badge is "how many things should I go look
 * at", and a run that failed four ways is still one thing to look at.
 */
export const isFailedRun = (r: AgentRun) =>
  r.status === 'FAILED' || r.toolCalls.some((c) => !c.ok);

/**
 * How many agent runs the flow tab would show as failed.
 *
 * This exists because the left column is tabbed: the flow is invisible while
 * the calendar is up, so a failure has to be able to reach you through the tab
 * strip. That only works if the badge and the panel can never disagree, so this
 * deliberately does NOT fetch its own copy — it is a `useQuery` on the exact key
 * `AgentActivity` uses, which means one cache entry, one fetch, one truth. The
 * same `isNewsworthy` filter is applied for the same reason: badging a run the
 * panel would not even list sends the owner to a tab with nothing in it.
 *
 * While the query is loading or has errored, this is 0 — no badge. That is the
 * honest reading: we have no evidence of a failure yet, and the flow tab shows
 * the fetch error itself the moment it is opened.
 */
export function useFailureCount(): number {
  const q = useQuery({ queryKey: ['agent-runs'], queryFn: listAgentRuns });
  return (q.data ?? []).filter(isNewsworthy).filter(isFailedRun).length;
}
