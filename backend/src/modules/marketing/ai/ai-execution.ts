/**
 * WHO does this workspace's AI work — its own connected Claude, or the
 * platform's key — and how long the connector gets first refusal.
 *
 * A leaf module with no imports, for the same reason `research-execution.ts`
 * is one: the generic `ScheduledJobRunnerService` has to express this decision
 * inside a claim predicate, and it must not import anything that imports it
 * back. The two files are siblings on purpose — research answered this
 * question first, for one nightly job, and the answer generalises.
 *
 * ## The rule, in one line
 *
 * MCP first. The platform's key is the FALLBACK, never the default.
 *
 * That is a product decision, not a cost optimisation. The product is meant to
 * be usable by someone who already has a Claude account: they connect it, the
 * platform carries the durable half — channels, state, scheduling, sending —
 * and their own Claude does the thinking. A platform that reaches for its own
 * key first would be reselling tokens to a customer who is already paying for
 * them.
 *
 * ## Why there are four modes and not three
 *
 * `research-execution.ts` has SERVER / MCP / AUTO, and `MCP` there still falls
 * back after six hours because its invariant is "research never silently
 * stops". That invariant is right for a nightly job and insufficient here,
 * because a workspace can legitimately want the platform key to be used NEVER
 * — not as a preference, as a guarantee. Without a mode that says so, "get off
 * the platform key" is not something the product can promise; it is only
 * something it can usually do.
 *
 *  - `SERVER`   — the platform does it immediately. Today's behaviour.
 *  - `AUTO`     — the default: MCP while a Claude is actually connected,
 *                 SERVER otherwise.
 *  - `MCP`      — the connector gets first refusal; the platform takes over
 *                 after `AI_MCP_GRACE_MS` and SAYS SO.
 *  - `MCP_ONLY` — the platform never runs it. The work waits for the agent for
 *                 as long as that takes.
 *
 * `MCP_ONLY` is the only mode that can leave work undone, so it is the only
 * one that must be chosen explicitly. Everything else fails safe towards the
 * platform (see `effectiveAiExecution`).
 */

/**
 * The scheduled-job kind the AI reply lane drains.
 *
 * It lives HERE, beside the rule that decides who may drain it, rather than
 * inside the engine that enqueues it — `ScheduledJobRunnerService` has to name
 * it in a claim predicate, and a service the runner imports cannot be one that
 * imports the runner back. `research-kinds.ts` exists for the same reason.
 */
export const AI_REPLY_KIND = 'conversation.ai_reply';

export const AI_EXECUTION_MODES = ['SERVER', 'AUTO', 'MCP', 'MCP_ONLY'] as const;
export type AiExecutionMode = (typeof AI_EXECUTION_MODES)[number];

/** What the caller acts on, once the stored mode meets the live signal. */
export type EffectiveAiExecution = 'SERVER' | 'MCP' | 'MCP_ONLY';

/**
 * How long the connector holds first refusal before the platform steps in.
 *
 * MINUTES, where research uses hours, and the difference is the whole reason
 * this is a separate constant: a nightly research job is compared against the
 * morning it exists to protect, and a customer waiting on a reply is compared
 * against their patience. Fifteen minutes is long enough for a connector that
 * polls on a short schedule to win the job, and short enough that a workspace
 * on `MCP` rather than `MCP_ONLY` has not chosen an hour of silence.
 *
 * It does not apply to `MCP_ONLY` at all — there is nothing to fall back to.
 */
export const AI_MCP_GRACE_MS = Number(process.env.AI_MCP_GRACE_MS ?? 15 * 60 * 1000);

/** Jobs enqueued at or before this instant are the platform's to take. */
export function aiGraceCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - AI_MCP_GRACE_MS);
}

/**
 * The stored mode plus the live connection signal, resolved.
 *
 * FAIL-SAFE TOWARDS SERVER, exactly as `effectiveResearchExecution` is: a NULL
 * from a row this code did not write, a typo, a value from a future migration
 * — all of them mean the platform still does the work, because the failure
 * mode of guessing MCP is a queue handed to a client that does not exist.
 *
 * The one asymmetry: `MCP_ONLY` is honoured whatever the connection signal
 * says. It is a promise that the platform key will not be used, and a promise
 * that quietly breaks itself the moment a heuristic decides nobody is
 * connected is not a promise. A workspace that sets it and then never runs its
 * Claude gets a queue that visibly waits — which is the honest outcome, and
 * why the queue depth has to be reported rather than left to be noticed.
 */
export function effectiveAiExecution(
  stored: string | null | undefined,
  mcpActiveRecently: boolean,
): EffectiveAiExecution {
  if (stored === 'MCP_ONLY') return 'MCP_ONLY';
  if (stored === 'MCP') return 'MCP';
  if (stored === 'AUTO' && mcpActiveRecently) return 'MCP';
  return 'SERVER';
}

/** True when the platform may run this work itself, given the mode and how
 *  long the job has already waited. The single place that decision is made. */
export function platformMayRun(
  effective: EffectiveAiExecution,
  enqueuedAt: Date,
  now: Date = new Date(),
): boolean {
  if (effective === 'SERVER') return true;
  if (effective === 'MCP_ONLY') return false;
  return enqueuedAt.getTime() <= aiGraceCutoff(now).getTime();
}
