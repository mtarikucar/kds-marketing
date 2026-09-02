import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../../common/scheduling/advisory-lock';
import { workspaceLocalParts } from '../../../../common/scheduling/workspace-local-day';
import { StrategyOrchestrator } from './strategy-orchestrator.service';
import { ScheduledJobRunnerService } from '../../scheduling/scheduled-job-runner.service';
import { AUTOPILOT_ARM_KIND } from '../strategy.service';

/** Workspace-local hour the plan is driven. Deliberately BEFORE the daily
 *  digest's 07:00 so the morning brief reports a run that has already happened
 *  rather than one that is still to come. */
const DEFAULT_APPLY_HOUR = 5;

/**
 * Read the apply hour, refusing anything that is not a real hour.
 *
 * `Number(undefined-or-typo)` is NaN, and the gate below is `hour < APPLY_HOUR`
 * - which is FALSE for NaN. A mistyped env would therefore not delay the driver,
 * it would REMOVE the gate: every armed workspace driven at the first tick after
 * deploy, at whatever local hour that lands on, and the "runs before the 07:00
 * digest" ordering the brief depends on quietly gone. The digest cron's `!==`
 * gate fails the other way and goes silent instead. An unattended actor is the
 * wrong place for either surprise, so an unusable value falls back to the
 * documented default rather than changing when the machine acts.
 */
function applyHour(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_APPLY_HOUR;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : DEFAULT_APPLY_HOUR;
}

const APPLY_HOUR = applyHour(process.env.STRATEGY_APPLY_HOUR);

/**
 * What one tick did, summed over the workspaces it drove.
 *
 * `attempted` and `applied` are separate because they answer different
 * questions and only one of them used to exist: `attempted` is how many actions
 * were handed to an executor (the work and the risk), `applied` is how many
 * came back having produced anything (the result). A tick that attempts ten and
 * produces zero is a tick worth looking at, and it used to log as "applied 10".
 */
export interface TickOutcome {
  workspaces: number;
  attempted: number;
  applied: number;
  skipped: number;
}

/** One counter row per workspace per LOCAL day — the idempotency key. */
const CLAIM_METRIC = 'autopilot.apply';

/**
 * Claim a workspace's local day for the autopilot, returning false when it is
 * already taken.
 *
 * Exported because ARMING claims the same day: `setAutonomy` applies the plan
 * immediately, and without writing this row the next hourly tick finds the day
 * unclaimed and drives the same plan again — so day one could run twice the
 * per-run cap. One claim, one definition, both callers.
 */
export async function claimAutopilotDay(
  prisma: PrismaService,
  workspaceId: string,
  localDate: string,
): Promise<boolean> {
  try {
    await prisma.usageCounter.create({
      data: { workspaceId, metric: CLAIM_METRIC, periodKey: localDate, value: 1 },
    });
    return true;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
    throw e;
  }
}

/** Upper bound on workspaces driven per tick. See the note on windowing below:
 *  this bounds one run, it does not bound which workspaces ever run. */
const MAX_WORKSPACES_PER_RUN = 50;

/**
 * The daily strategy-apply tick — the driver the Strategy Engine never had.
 *
 * THE DEADLOCK THIS EXISTS TO BREAK. `applyPlan` had exactly one caller: the
 * tail of a synthesis run. Synthesis on a cadence has exactly one caller: the
 * weekly feedback cron, which skips a workspace unless some StrategyAction has
 * an `updatedAt` newer than the strategy row — and synthesis's `persist()`
 * deliberately touches the strategy row LAST, so a freshly-seeded plan never
 * qualifies. Nothing moves an action except `applyPlan` or a human clicking
 * approve. Written as a chain:
 *
 *     applyPlan runs  <=  synthesis runs  <=  weekly cron fires
 *                     <=  an action moved  <=  applyPlan or a human ran
 *
 * With a plan full of PROPOSED actions and no human, that weekly cron skips the
 * workspace every week, forever. The engine was not idle by policy; it was
 * unreachable. This cron is the entry point: it calls `applyPlan` on a clock,
 * independently of synthesis, so the autonomy lane an owner armed actually has
 * something that drives it.
 *
 * IT ADDS NO AUTHORITY. Every gate `applyPlan` already enforces still runs and
 * is untouched: the workspace must have set `autonomyLevel = AUTONOMOUS`
 * itself (a MANAGER-only, audited panel gesture that no agent can make), the
 * env kill-switch still decides whether spend/publish kinds may run at all, and
 * MAX_AUTO_ACTIONS still caps one sweep. This cron supplies a clock and nothing
 * else. It creates no campaign, activates nothing, changes no publish path, and
 * flips no workspace's autonomy level.
 *
 * WHY HOURLY FOR A DAILY JOB, AND WHY A CLAIM ROW. Same two reasons the daily
 * digest is built this way:
 *
 *  - A workspace is driven when the clock reads APPLY_HOUR in ITS OWN timezone.
 *    Prod containers run UTC and the customers run UTC+3; a "daily" boundary
 *    taken from server-local time is a documented bug class here, not a
 *    hypothetical.
 *  - The run is claimed by CREATING a UsageCounter row keyed on the workspace's
 *    LOCAL date, so a restart inside the same hour, a second replica, or a
 *    catch-up pass finds the row taken and stays out. The advisory lock stops
 *    two replicas overlapping; only the claim stops one day being driven twice.
 *
 * WHY THE CAP IS NOT A `take: N` SWEEP. This codebase has a documented
 * recovery-sweep failure: an `orderBy + take` reconcile with no queryable
 * not-done predicate pins itself to the oldest N rows forever, and anything
 * born outside that window is never revisited. So the workspace set here comes
 * from a PREDICATE (`ACTIVE` strategy, `AUTONOMOUS` lane, `ACTIVE` workspace)
 * and the claim row IS the not-done marker: a workspace that already ran today
 * is excluded by a unique-constraint failure, not by its position in a sort.
 * MAX_WORKSPACES_PER_RUN therefore bounds the work of one tick, while the gate
 * is `hour >= APPLY_HOUR` rather than `hour === APPLY_HOUR` — a workspace the
 * cap pushed out of the 05:00 tick is picked up at 06:00, and there are
 * nineteen more hours of local day behind it. No workspace can be starved by
 * the cap; it can only be delayed by it.
 */
@Injectable()
export class StrategyApplyCron {
  private readonly logger = new Logger(StrategyApplyCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: StrategyOrchestrator,
    private readonly runner: ScheduledJobRunnerService,
  ) {}

  /**
   * The first run of a plan the owner has just armed.
   *
   * `setAutonomy` claims the day and queues this rather than applying inline —
   * a settings write must return, and one LEAD_HUNT alone is budgeted at two
   * minutes. The handler lives here because this file already owns what a run
   * IS; the service only decides that one should happen.
   */
  onModuleInit(): void {
    this.runner.registerHandler(AUTOPILOT_ARM_KIND, async (job) => {
      const workspaceId = String((job.payload as { workspaceId?: string })?.workspaceId ?? '');
      if (!workspaceId) return;
      const r = await this.orchestrator.applyPlan(workspaceId);
      this.logger.log(
        `autopilot armed for ws ${workspaceId}: ran ${r.attempted} action(s), ` +
          `${r.applied} produced something, ${r.skipped} left with a reason`,
      );
    });
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'strategy-apply-tick' })
  async tick(): Promise<TickOutcome> {
    let outcome: TickOutcome = { workspaces: 0, attempted: 0, applied: 0, skipped: 0 };
    // Caught here, NOT inside the lock: withAdvisoryLock records the failure on
    // the job heartbeat before rethrowing, so the error still reaches the one
    // surface that can report it; this only stops a cron tick ending in an
    // unhandled rejection.
    try {
      await withAdvisoryLock(
        this.prisma,
        'strategy:apply',
        async () => {
          outcome = await this.runAll();
        },
        this.logger,
      );
    } catch (e) {
      this.logger.error(`strategy-apply-tick: ${(e as Error)?.message ?? e}`);
    }
    return outcome;
  }

  /** Drive every AUTONOMOUS workspace whose local day has reached APPLY_HOUR
   *  and has not been driven yet today. */
  async runAll(now = new Date()): Promise<TickOutcome> {
    const strategies = await this.prisma.marketingStrategy.findMany({
      where: { status: 'ACTIVE', autonomyLevel: 'AUTONOMOUS' },
      select: { workspaceId: true },
    });
    // Self-gating: with no armed workspace this cron costs one indexed count a
    // hour and stays completely dormant, exactly like the feedback tick.
    if (!strategies.length) return { workspaces: 0, attempted: 0, applied: 0, skipped: 0 };

    // Deliberately NOT ordered. Ordering plus a cap is the shape that starves a
    // tail; the claim row is what makes an unordered pass converge instead.
    const workspaces = await this.prisma.workspace.findMany({
      where: { id: { in: strategies.map((s) => s.workspaceId) }, status: 'ACTIVE' },
      select: { id: true, timezone: true },
    });

    let driven = 0;
    let attempted = 0;
    let applied = 0;
    let skipped = 0;
    for (const ws of workspaces) {
      if (driven >= MAX_WORKSPACES_PER_RUN) break;
      const { hour, date } = workspaceLocalParts(ws.timezone, now);
      if (hour < APPLY_HOUR) continue;

      // Claim the day BEFORE driving. If the apply later throws, the day stays
      // claimed and the next hourly tick does not re-drive a plan that may
      // already be half-executed — a restart storm must not turn one day's
      // plan into a dozen runs of it.
      if (!(await claimAutopilotDay(this.prisma, ws.id, date))) continue;
      driven += 1;

      try {
        const result = await this.orchestrator.applyPlan(ws.id);
        attempted += result.attempted;
        applied += result.applied;
        skipped += result.skipped;
      } catch (e) {
        // One workspace's failure must not cost the rest of them their day.
        this.logger.warn(`strategy-apply failed for ws ${ws.id}: ${(e as Error)?.message ?? e}`);
      }
    }

    if (driven) {
      this.logger.log(
        `strategy-apply-tick: drove ${driven} workspace(s), ran ${attempted} action(s) of which ` +
          `${applied} produced something, left ${skipped} with a reason`,
      );
    }
    return { workspaces: driven, attempted, applied, skipped };
  }
}
