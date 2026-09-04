/**
 * Why a StrategyAction did NOT run.
 *
 * Before these existed, an action the autonomous sweep declined was
 * indistinguishable from an action the sweep never reached: both sat at
 * PROPOSED with a null `resultRef`, and the only trace was a counter in a log
 * nobody reads. "The machine is idle" and "the machine decided, for this
 * reason" are completely different products to the person paying for it, and no
 * reporting surface can tell them apart without a stamp on the row.
 *
 * The marker rides in `StrategyAction.resultRef`: there is no error/reason
 * column on the model, and `execute` already uses that field as its failure
 * channel (`error:<message>`), so this follows the convention that is already
 * there rather than adding a migration for three strings.
 *
 * Kept in its own file, deliberately: the daily digest renders these and must
 * not import the orchestrator — which would pull every executor, and through
 * them the social planner and the content AI, into the analytics module graph
 * for the sake of three constants.
 */

/** Every "did not run, here is why" marker starts with this. */
export const SKIP_PREFIX = 'skipped:';

/** The env kill-switch is off, so a spend/publish kind stays PROPOSED. */
export const SKIP_KILL_SWITCH = `${SKIP_PREFIX}kill-switch`;

/** MAX_AUTO_ACTIONS was already spent this run; the action waits for the next. */
export const SKIP_RUN_CAP = `${SKIP_PREFIX}run-cap`;

/** No executor is registered for this action's kind yet. */
export const SKIP_NO_EXECUTOR = `${SKIP_PREFIX}no-executor`;
