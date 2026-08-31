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

/**
 * The `ScheduledJob.payload` key that marks a research job a HUMAN asked for
 * right now, rather than one the nightly cron fanned out.
 *
 * Lives here, beside the kind, for exactly the same reason: the generic
 * `ScheduledJobRunnerService` reads it inside its claim predicate and must not
 * import the research runner back.
 *
 * ## Why a payload flag and not a second `kind`
 *
 * A distinct kind (`research.run.now`) would need no predicate change at all —
 * the exclusion is keyed on `kind`, so an unknown kind is simply never held.
 * It was rejected anyway, on two counts:
 *
 *  - **It would run the night twice.** Dedup is `(kind, dedupKey)`, so a manual
 *    kind cannot collapse onto the PENDING nightly row for the same profile.
 *    Both rows would execute, and a research run is the single most expensive
 *    thing in the product — the entire reason the MCP lane leases rather than
 *    reads.
 *  - **Every other reader is keyed on the one kind.** `ResearchLeaseService`
 *    (claim, queueStatus, releaseExpired, recordPlatformTakeover,
 *    recentPlatformTakeovers) all filter `kind = RESEARCH_RUN_KIND`. A second
 *    kind would be invisible to all of them — a manual run would never appear
 *    in the queue count, never be leasable, never be recorded as a takeover.
 *
 * The flag keeps ONE kind and one row per profile, and the dedup collapse
 * becomes the feature rather than the bug: a "Run now" issued while tonight's
 * nightly row is still held updates that row's payload in place
 * (`ScheduledJobService.schedule`), which PROMOTES it out of the grace window
 * instead of inheriting its six-hour clock. The human pressed the button for
 * that profile; the job they get is that profile's job.
 *
 * The reverse collapse — the 03:00 cron writing over a still-PENDING manual row
 * and clearing the flag — is left alone deliberately. A manual row is claimable
 * by the platform within one runner tick, so surviving to 03:00 means the
 * runner itself is down, and nothing on this row is the interesting problem
 * then.
 */
export const RESEARCH_MANUAL_KEY = 'manual';
