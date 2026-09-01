import { Body, ConflictException, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional } from 'class-validator';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { StrategyService, AUTONOMY_LEVELS } from './strategy.service';
import { StrategyFeedbackService } from './feedback/strategy-feedback.service';

const ACTION_STATUSES = ['PROPOSED', 'APPROVED', 'RUNNING', 'DONE', 'FAILED', 'DISMISSED'] as const;

/** Single-quote a lock key for the raw advisory-lock SELECT (same helper the
 *  ai-credits / message-quota / research-profile quota paths carry). */
function escapeLockKey(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}

/**
 * How long the refresh lock's transaction may be held.
 *
 * Deliberately read from the SAME env var synthesis bounds its tool-loop with
 * (`STRATEGY_SYNTH_MAX_MS`, default 180s), plus a margin for persist() and the
 * feedback service's own reads on either side of it. It is not imported from
 * strategy-synthesis.service.ts on purpose: that module pulls in the Anthropic
 * SDK, the orchestrator and the whole research toolset, and this controller —
 * which is deliberately two lines of delegation and a spec that instantiates it
 * with `new` — has no business dragging any of that in to learn a number. The
 * coupling is one env var name, restated here rather than hidden.
 *
 * If the body ever does outrun this, the transaction is torn down, the lock is
 * released with it, and the caller gets an error — which is strictly better
 * than a lock leaked to an idle pooled connection, the failure mode
 * `common/scheduling/advisory-lock.ts` documents at length from having lived it.
 */
const REFRESH_LOCK_TIMEOUT_MS = Number(process.env.STRATEGY_SYNTH_MAX_MS ?? 180_000) + 30_000;

class ListActionsQueryDto {
  @IsOptional() @IsIn(ACTION_STATUSES)
  status?: string;
}

class SetAutonomyDto {
  @IsIn(AUTONOMY_LEVELS as unknown as string[])
  level: string;
}

/**
 * Strategy Engine — the console read/decision surface over the synthesized
 * strategy + its ActionPlan. Reads are reports.read; the approve/dismiss/autonomy
 * decisions govern what the engine is allowed to execute, so they carry the same
 * MANAGER + settings.manage + audited stack as the budget-autopilot controls.
 * `refresh` joins them: it neither reads nor decides but REPLACES the plan, and
 * spends real money doing so, which puts it firmly on the write side of that
 * split (see its own comment for what it destroys and why the cron's skip gate
 * constrains what this handler is allowed to do afterwards).
 */
@MarketingRoute()
@Controller('marketing/strategy')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class StrategyController {
  constructor(
    private readonly strategy: StrategyService,
    private readonly feedback: StrategyFeedbackService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermission('reports.read')
  getStrategy(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.strategy.getStrategy(a.workspaceId);
  }

  @Get('actions')
  @RequirePermission('reports.read')
  listActions(@CurrentMarketingUser() a: MarketingUserPayload, @Query() q: ListActionsQueryDto) {
    return this.strategy.listActions(a.workspaceId, { status: q.status });
  }

  @Post('actions/:id/approve')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.action.approve', resourceType: 'strategy_action', resourceIdParam: 'id' })
  approve(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.strategy.approveAction(a.workspaceId, id);
  }

  @Post('actions/:id/dismiss')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.action.dismiss', resourceType: 'strategy_action', resourceIdParam: 'id' })
  dismiss(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.strategy.dismissAction(a.workspaceId, id);
  }

  @Post('autonomy')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.autonomy', resourceType: 'marketing_strategy', captureBody: ['level'] })
  setAutonomy(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: SetAutonomyDto) {
    return this.strategy.setAutonomy(a.workspaceId, dto.level);
  }

  /**
   * Re-synthesize the strategy and REPLACE its ActionPlan, folding in what the
   * current plan's execution actually produced.
   *
   * WHY THIS ROUTE HAD TO EXIST. Re-synthesis was already implemented three
   * times over — the onboarding wizard's POST /strategy/intake/finish, the
   * weekly StrategyFeedbackCron, and the `jeeta.synthesize_strategy` MCP tool —
   * and a panel operator could reach none of them. `finish` needs a mid-wizard
   * `sessionId` that only the wizard holds, the cron runs when it runs, and MCP
   * is a different client entirely. So the console could show a stale plan and
   * offer no way to ask for a new one; the only workaround was to walk the
   * whole intake interview again, and that path calls synthesis WITHOUT the
   * outcome summary — it discards the very thing that makes a refresh worth
   * running.
   *
   * It delegates to StrategyFeedbackService.refresh — deliberately NOT
   * StrategySynthesisService.synthesize — for the same reason the MCP tool
   * does: refresh is the workspace-only entry point. It resolves the
   * workspace's most recent intake session (the id a panel caller has no way
   * to know), builds the execution-outcome summary from the plan's DONE
   * actions and ad metrics, and hands both to synthesis. With no ACTIVE
   * strategy or no intake session it returns `{ skipped }` rather than
   * throwing — a workspace that has never been through onboarding gets a
   * truthful no-op, not a 500.
   *
   * (a) THIS IS DESTRUCTIVE, AND THE UI MUST TREAT IT AS SUCH. Synthesis's
   * persist() runs `strategyAction.deleteMany({ where: { workspaceId,
   * strategyId } })` with NO status filter before inserting the new plan.
   * Every StrategyAction goes: not only the PROPOSED ones nobody acted on, but
   * DONE and FAILED rows too — and with them their `resultRef`s, which are the
   * only link from an action to the research run / staged post / community
   * drop / campaign shell it produced. The refreshed plan is a clean slate with
   * no execution history behind it. That is why this is a POST behind an
   * explicit operator gesture and why the console puts a confirm in front of
   * it; it is emphatically not a "reload" button.
   *
   * (b) THIS HANDLER MUST NOT WRITE ANYTHING AFTER THE REFRESH. persist() ends
   * by touching the MarketingStrategy row LAST — deliberately, after the
   * actions it just seeded — so the run leaves `strategy.updatedAt` strictly
   * newer than every `action.updatedAt`. That ordering is the whole basis of
   * the weekly feedback cron's skip gate, which asks "has any StrategyAction
   * moved since the strategy was last written?" (`strategyAction.findFirst({
   * updatedAt: { gt: strategy.updatedAt } })`) and re-synthesizes only when the
   * answer is yes. Seed the actions after the strategy instead and the answer
   * is yes for every ACTIVE workspace forever: the cron then bills a full Opus
   * re-synthesis plus live crawl spend on all of them every week, including the
   * ones nobody has opened in months. That regression has already happened once
   * here, which is why persist() carries a comment about it.
   *
   * So this handler returns `feedback.refresh()`'s result untouched and writes
   * nothing of its own. Two shapes of "small addition" would break it and both
   * look harmless: stamping the freshly-seeded actions with anything (a
   * `refreshedBy`, a re-ordering, a bulk status touch) makes them newer than
   * the strategy and re-opens the gate directly; and re-touching the strategy
   * row here is the first half of that same inversion — it invites a follow-up
   * action write to be appended after it later. If bookkeeping is ever genuinely
   * needed, it belongs INSIDE persist(), before the final strategy write, where
   * the ordering is owned and documented.
   *
   * (The one legitimate way an action ends up newer than the strategy is
   * execution: the orchestrator's post-synthesis `applyPlan` running an
   * AUTONOMOUS workspace's plan, or a human approving an action later. Those
   * ARE new outcomes, and the cron re-synthesizing on them is precisely what
   * the gate is for.)
   *
   * COST. A refresh is the single most expensive thing the product does: a
   * bounded Opus tool-loop over live research, charged as one
   * `strategy.synthesize` reserve plus one `strategy.turn` per turn, up to
   * MAX_ITERS turns, on top of the firecrawl/apify money that meters into the
   * RESEARCH budget. All of that metering, its refund-on-failure and its
   * inert-when-unconfigured behaviour live INSIDE synthesis, which is exactly
   * how POST /strategy/intake/finish is wired — that path adds no credit or
   * entitlement guard of its own either, because duplicating the reserve at the
   * controller would double-charge. So this route carries the same stack as
   * finish() and the other AI-metered governance surfaces (MANAGER +
   * settings.manage + audited) and nothing more: an exhausted workspace gets a
   * truthful AI_CREDITS_EXHAUSTED out of the reserve rather than a silent
   * no-op.
   *
   * (c) ONE REFRESH AT A TIME, PER WORKSPACE. Everything above describes a
   * single run in isolation; two overlapping runs break it in both directions
   * at once. persist() is upsert → deleteMany → createMany → update with no
   * transaction and no lock, so interleaving two runs leaves BOTH plans under
   * one strategy — duplicated ideas, up to 48 actions where the cap is 24 — and
   * if run A's closing `marketingStrategy.update` lands before run B's
   * createMany, the strategy row ends up OLDER than its own actions. That is
   * exactly the inversion (b) exists to prevent, re-opened from a direction no
   * amount of care inside this handler could close: it hands the weekly cron a
   * permanently-open skip gate and an extra billed Opus re-synthesis every week,
   * on top of the two the operator just paid for by double-clicking.
   *
   * So the run takes a per-workspace advisory lock, the same primitive the rest
   * of the request path serializes read-modify-writes with (ai-credits,
   * message-quota, research-profile caps). The `try_` variant, not the blocking
   * one, and that choice is the whole point: a plain `pg_advisory_xact_lock`
   * would QUEUE the second call behind a run that may take three minutes, so an
   * impatient double-click buys a second full-price synthesis that starts the
   * moment the first ends and immediately wipes its plan. Failing fast with a
   * 409 says the true thing — one is already running — and costs nothing.
   *
   * The lock is held by an interactive transaction that does no other work; the
   * refresh itself runs on the normal pool inside it. That pins acquire, hold
   * and release to one connection and releases at COMMIT/ROLLBACK even if the
   * process dies mid-run, for the reasons `common/scheduling/advisory-lock.ts`
   * spells out. The price is one pooled connection parked for the length of the
   * synthesis, which is the same price the cron path already pays and cheap
   * against what a duplicated run costs.
   *
   * (Worth naming, because it looks like this fixes it and does not: the run is
   * still awaited synchronously for up to MAX_WALL_MS, and the frontend's axios
   * client sets no timeout, so an intermediary read timeout can still show the
   * operator an error while the synthesis is happily running. The lock makes
   * their inevitable retry harmless — a truthful 409 instead of a second run —
   * but the real fix for the wait is to make this asynchronous, which is a
   * larger change than this route.)
   */
  @Post('refresh')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  // The single most expensive call in the product: a bounded Opus tool-loop over
  // live research, billed as one `strategy.synthesize` reserve plus a
  // `strategy.turn` per turn, plus firecrawl/apify money against the RESEARCH
  // budget. The credit meter is the long-run budget but is unbounded on a -1
  // (unlimited) plan, so burst spend has to be capped at the edge — the same
  // reasoning, and the same decorator, that /ai/compose (10) and /ai/command (6)
  // already carry. Tighter than either of them because one call here costs more
  // than a hundred of those, and because a legitimate operator has no reason to
  // ask for a third new strategy inside a minute.
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Audit({ action: 'strategy.refresh', resourceType: 'marketing_strategy' })
  refresh(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.withRefreshLock(a.workspaceId, () => this.feedback.refresh(a.workspaceId));
  }

  /**
   * Run `fn` while holding this workspace's refresh lock, or refuse.
   *
   * `pg_try_advisory_xact_lock` returns immediately: true and we own it until
   * this transaction ends, false and somebody else is mid-refresh. `hashtext`
   * over a namespaced key is the same lock-id derivation every other
   * per-workspace lock in this codebase uses, so a collision would have to be a
   * hash collision rather than a naming accident.
   */
  private async withRefreshLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock(hashtext(${escapeLockKey(
            'strategy-refresh:' + workspaceId,
          )})) AS locked`,
        );
        if (!rows[0]?.locked) {
          throw new ConflictException({
            code: 'STRATEGY_REFRESH_IN_PROGRESS',
            message: 'A strategy refresh is already running for this workspace',
          });
        }
        return fn();
      },
      { maxWait: 5_000, timeout: REFRESH_LOCK_TIMEOUT_MS },
    );
  }
}
