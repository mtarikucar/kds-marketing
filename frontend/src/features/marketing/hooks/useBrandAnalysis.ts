import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  startBrandAnalysis,
  getBrandAnalysisRun,
  applyBrandAnalysis,
  type StartAnalysisInput,
  type BrandAnalysisRun,
  type BrandAnalysisDraft,
} from '../api/brandBrain.service';

const TERMINAL: BrandAnalysisRun['status'][] = ['READY_FOR_REVIEW', 'APPLIED', 'FAILED'];

/**
 * Starts a brand-analysis run and polls it every 3s until it reaches a terminal
 * status (READY_FOR_REVIEW / APPLIED / FAILED). Non-blocking + resumable — a
 * caller can also seed an existing runId to resume polling.
 */
export function useBrandAnalysis() {
  const [runId, setRunId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const start = useMutation({
    mutationFn: (input: StartAnalysisInput) => startBrandAnalysis(input),
    onSuccess: (r) => setRunId(r.runId),
  });

  const run = useQuery({
    queryKey: ['marketing', 'brand-brain', 'run', runId],
    queryFn: () => getBrandAnalysisRun(runId as string),
    enabled: !!runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL.includes(status) ? false : 3000;
    },
  });

  const apply = useMutation({
    mutationFn: ({ runId: id, draft }: { runId: string; draft?: BrandAnalysisDraft }) =>
      applyBrandAnalysis(id, draft ?? undefined),
    onSuccess: (_res, vars) => {
      // The backend flips the run to APPLIED on a successful apply, but
      // polling already stopped at the READY_FOR_REVIEW terminal status
      // (APPLIED is also terminal, so a refetch would never happen either).
      // Patch the cached run directly so the wizard's `step` (derived from
      // run.data.status) advances to 'done' instead of staying stuck on
      // 'review' — otherwise a second Apply click would 400 against an
      // already-applied run.
      queryClient.setQueryData(
        ['marketing', 'brand-brain', 'run', vars.runId],
        (old: BrandAnalysisRun | undefined) => (old ? { ...old, status: 'APPLIED' as const } : old),
      );
    },
  });

  return {
    start,
    apply,
    run,
    runId,
    setRunId, // resume polling an existing run
    reset: () => setRunId(null),
    isPolling: !!runId && !!run.data && !TERMINAL.includes(run.data.status),
  };
}
