import { useQuery } from '@tanstack/react-query';
import { listAgentRuns } from '../../../features/marketing/api/command.service';
import { isFailedRun, selectActivityRuns } from './AgentActivity';

/**
 * How many of the runs the flow tab is showing went wrong.
 *
 * This exists because the left column is tabbed: the flow is invisible while
 * the calendar is up, so a failure has to be able to reach you through the tab
 * strip. That only works if the badge and the panel can never disagree, which
 * takes agreement on three separate things — and all three are owned by
 * `AgentActivity`, not re-derived here:
 *
 *   - the DATA: a `useQuery` on the exact key the panel uses, so one cache
 *     entry, one fetch, one truth;
 *   - the WINDOW: `selectActivityRuns`, so the badge cannot count a failure
 *     that fell off the end of the list it points at;
 *   - the VERDICT: `isFailedRun`, so "failed" means on the tab strip what it
 *     means in the panel.
 *
 * Each one of those was a real divergence at some point in this file's life.
 * Keeping them in the panel is what makes them impossible rather than merely
 * currently-correct.
 *
 * While the query is loading or has errored, this is 0 — no badge. We have no
 * evidence of a failure yet, and the flow tab shows the fetch error itself the
 * moment it is opened.
 */
export function useFailureCount(): number {
  const q = useQuery({ queryKey: ['agent-runs'], queryFn: listAgentRuns });
  return selectActivityRuns(q.data ?? []).filter(isFailedRun).length;
}
