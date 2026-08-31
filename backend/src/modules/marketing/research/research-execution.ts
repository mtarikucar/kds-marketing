/**
 * Who gets FIRST REFUSAL on a workspace's nightly research, and for how long.
 *
 * A leaf module with no imports, for the same reason `research-kinds.ts` is
 * one: the generic `ScheduledJobRunnerService` has to name these constants in
 * its claim predicate, and it must not import anything that imports it back.
 *
 * ## The mode stopped meaning "who drains"
 *
 * v2.286.0 shipped a hard switch: `MCP` meant the platform NEVER touched that
 * workspace's research, and a customer who connected Claude once and never set
 * up a scheduled task had their research silently stop. That is this repo's
 * recurring failure — a broken thing wearing the costume of an empty result —
 * in its most expensive form.
 *
 * So the mode now means **who is asked first**:
 *
 *  - `SERVER` — the platform drains immediately (unchanged).
 *  - `MCP`    — the owner's Claude gets first refusal; if the job is still
 *               unclaimed `RESEARCH_MCP_GRACE_HOURS` after it was enqueued,
 *               the platform drains it anyway and SAYS SO.
 *  - `AUTO`   — the default: `MCP` while a Claude is actually connected,
 *               `SERVER` otherwise.
 *
 * "Research never silently stops" becomes a system-wide invariant, and that is
 * precisely what makes auto-defaulting safe: a wrong guess costs latency, never
 * a lost night.
 */

/** Every value `Workspace.researchExecution` may hold. */
export const RESEARCH_EXECUTION_MODES = ['AUTO', 'SERVER', 'MCP'] as const;
export type StoredResearchExecution = (typeof RESEARCH_EXECUTION_MODES)[number];

/** What the two drainers actually branch on. `AUTO` never reaches them. */
export type EffectiveResearchExecution = 'SERVER' | 'MCP';

/**
 * How long the owner's Claude holds first refusal, measured from the moment
 * the cron enqueued the job.
 *
 * The nightly cron fires at 03:00 (`research-runner.service.ts`), so six hours
 * hands the platform its turn at 09:00. Both bounds are real:
 *
 *  - LONGER is worse. At 12 or 24 hours the takeover lands in the afternoon or
 *    the next day, so the owner's morning panel still shows an empty review
 *    queue — the same silent stop, just postponed. The fallback has to rescue
 *    THIS morning to be a fallback at all.
 *  - SHORTER is worse too. A drainer scheduled for 06:00 or 08:00 is an
 *    entirely ordinary "overnight" task; a one- or two-hour window would pre-
 *    empt it, the platform would pay every night, and the feature would save
 *    nothing while its switch read MCP.
 *
 * Six hours covers the whole 03:00-09:00 band a nightly task plausibly runs
 * in, and still finishes before the morning it exists to protect. A takeover
 * run itself is bounded at two minutes (`RESEARCH_RUN_MAX_MS`), so the
 * candidates are staged by the time anyone looks.
 */
export const RESEARCH_MCP_GRACE_HOURS = 6;
export const RESEARCH_MCP_GRACE_MS = RESEARCH_MCP_GRACE_HOURS * 60 * 60 * 1000;

/**
 * The `AgentRun.agent` value every MCP tool call opens its run under
 * (`McpInvokerService.invoke`). THE connection signal — see below.
 */
export const MCP_ACTIVITY_AGENT = 'mcp';
/**
 * The `AgentRun.agent` value `ResearchLeaseService.claim()` opens after a
 * SUCCESSFUL atomic claim — one row per research job an MCP client actually
 * leased, written nowhere else.
 *
 * This is the completion signal for the "connect your Claude" setup step, and
 * the reason that step is not measured by "an API key exists": a key is intent,
 * and a key with no scheduled task behind it looks exactly like a working lane.
 * A `research.mcp` run is proof the lane RAN. Named here, beside
 * `MCP_ACTIVITY_AGENT`, so writer and reader cannot drift — a renamed literal
 * would leave that step silently uncompletable forever.
 */
export const MCP_RESEARCH_AGENT = 'research.mcp';

/**
 * How recently an MCP tool call must have happened for `AUTO` to read as
 * connected.
 *
 * The question this answers is "is there a Claude on the other end of this
 * workspace", and the cost of either wrong answer is now bounded by the grace
 * window — a false positive delays research by six hours, a false negative
 * spends platform money on a night the owner would have paid for. Neither
 * loses a run, so the threshold is tuned to minimise PERSISTENT wrongness
 * rather than to be timid.
 *
 * Fourteen days spans a fortnight's holiday plus the ordinary rhythm of
 * someone who opens their connector a couple of times a month, so a genuinely
 * connected workspace does not flicker back to SERVER; and it expires inside a
 * single billing cycle for a workspace that tried the connector once and
 * walked away, so that workspace stops paying six hours of first-refusal
 * latency every night within a fortnight.
 *
 * For the case that actually matters it is 14x the margin needed: a workspace
 * running the nightly drainer calls `claim_research_job` EVERY night.
 */
export const MCP_CONNECTION_STALE_DAYS = 14;
export const MCP_CONNECTION_STALE_MS = MCP_CONNECTION_STALE_DAYS * 24 * 60 * 60 * 1000;

/** Jobs enqueued at or before this instant are the platform's to take. */
export function researchGraceCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - RESEARCH_MCP_GRACE_MS);
}

/** An MCP tool call at or after this instant counts as "connected". */
export function mcpActivityCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - MCP_CONNECTION_STALE_MS);
}

/**
 * The stored mode plus the live connection signal, resolved.
 *
 * FAIL-SAFE TOWARDS SERVER, exactly as `ResearchLeaseService.modeFor()` and
 * `McpConsoleService.overview()` already do: only the literal `'MCP'` and a
 * literal `'AUTO'` that detects a connection produce `MCP`. A NULL from a row
 * this code did not write, a typo, a value from a future migration — all of
 * them mean the platform is still draining, because the failure mode of
 * guessing MCP is a queue handed to a client that does not exist.
 *
 * `mcpActiveRecently` is deliberately a plain boolean rather than a query: the
 * SAME decision has to be expressible in the raw SQL of
 * `ScheduledJobRunnerService.claimBatch`, and the only way to keep two
 * implementations of one rule from drifting is to make the rule this small and
 * pin them against each other on real Postgres.
 */
export function effectiveResearchExecution(
  stored: string | null | undefined,
  mcpActiveRecently: boolean,
): EffectiveResearchExecution {
  if (stored === 'MCP') return 'MCP';
  if (stored === 'AUTO' && mcpActiveRecently) return 'MCP';
  return 'SERVER';
}
