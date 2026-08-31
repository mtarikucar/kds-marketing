/**
 * The `ScheduledJob.kind` the research engine runs on.
 *
 * A leaf module with no imports, purely so the generic
 * `ScheduledJobRunnerService` can name this kind in its claim predicate
 * without importing `research-runner.service` — which imports the runner right
 * back, and the cycle would be a real one, not a type-only one.
 *
 * `research-runner.service.ts` re-exports `RESEARCH_RUN_KIND` from here, so
 * every existing importer keeps working and there is still exactly one string.
 */
export const RESEARCH_RUN_KIND = 'research.run';
