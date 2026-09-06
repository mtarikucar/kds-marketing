import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AnthropicService } from '../../ai/anthropic.service';
import { AiCreditsService } from '../../ai/ai-credits.service';
import { creditCost, tierFor } from '../../ai/ai-credit-costs';
import { AgentRunService } from '../../agents/agent-run.service';
import { ResearchSourcesService } from '../../research/providers/research-sources.service';
import { ResearchSpendService } from '../../budget/research-spend.service';
import { RESEARCH_TOOLS, dispatchResearchTool, ResearchToolCtx } from '../../research/research-toolset';
import { validateBrief } from '../strategy.schema';
import { ARCHETYPES, archetypeMeta } from '../archetypes';
import { ActionKind, BusinessArchetype, StrategyActionItem } from '../strategy.types';
import { StrategyOrchestrator } from '../orchestrator/strategy-orchestrator.service';
import { StrategyProvisioningService } from '../provisioning/strategy-provisioning.service';

export interface StrategySynthesisResult {
  strategyId: string | null;
  actionCount: number;
  skipped?: string;
}

/**
 * What a credit-free submit returns. No `skipped`: a submit either wrote the
 * strategy or refused with a reason — there is no third state, because there is
 * no model call to be unable to make.
 */
export interface StrategySubmitResult {
  strategyId: string;
  /** Actions actually written, all PROPOSED. */
  actionCount: number;
  /** Submitted items normalization rejected. Reported so a partial save cannot
   *  read to the caller as a whole one. */
  droppedActions: number;
}

const MAX_ITERS = 10;
const MAX_TOOL_CALLS = 24;
const MAX_WALL_MS = Number(process.env.STRATEGY_SYNTH_MAX_MS ?? 180_000);
/** The most ActionPlan items one strategy may carry. Exported so the MCP submit
 *  tool can REFUSE a longer plan at its schema instead of silently truncating
 *  it, which is what `normalizeActions` does to a model mid-loop. */
export const MAX_ACTIONS = 24;
const ACTION_KINDS: ReadonlySet<string> = new Set<ActionKind>([
  'LEAD_HUNT',
  'CONTENT',
  'CHANNEL_SETUP',
  'AD_CAMPAIGN',
  'COMMUNITY_ENGAGE',
]);
const PRIORITIES: ReadonlySet<string> = new Set(['LOW', 'MEDIUM', 'HIGH']);

const SUBMIT_STRATEGY_TOOL: Anthropic.Tool = {
  name: 'submit_strategy',
  description:
    'Finalize the ONE marketing strategy. Call exactly once when your research is done. Provide the archetype key, a COMPLETE brief, and a prioritized ActionPlan.',
  input_schema: {
    type: 'object',
    properties: {
      archetype: { type: 'string', enum: Object.keys(ARCHETYPES) },
      brief: {
        type: 'object',
        description:
          'identity{product,voice,positioning,usp}, audience, channels[{key,fitScore(0-1),rationale}], contentPillars[{title,angle,formats[],tone}], goals{objective,kpis[]}, budget, competitors[]',
        properties: {
          identity: {
            type: 'object',
            properties: {
              product: { type: 'string' },
              voice: { type: 'string' },
              positioning: { type: 'string' },
              usp: { type: 'string' },
            },
            required: ['product', 'voice', 'positioning', 'usp'],
          },
          audience: { type: 'string' },
          channels: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, fitScore: { type: 'number' }, rationale: { type: 'string' } },
              required: ['key', 'fitScore', 'rationale'],
            },
          },
          contentPillars: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                angle: { type: 'string' },
                formats: { type: 'array', items: { type: 'string' } },
                tone: { type: 'string' },
              },
              required: ['title', 'angle', 'formats', 'tone'],
            },
          },
          goals: {
            type: 'object',
            properties: { objective: { type: 'string' }, kpis: { type: 'array', items: { type: 'string' } } },
            required: ['objective', 'kpis'],
          },
          budget: { type: 'string' },
          competitors: { type: 'array', items: { type: 'string' } },
        },
        required: ['identity', 'audience', 'channels', 'contentPillars', 'goals', 'budget', 'competitors'],
      },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...ACTION_KINDS] },
            title: { type: 'string' },
            rationale: { type: 'string' },
            payload: { type: 'object' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
          },
          required: ['kind', 'title', 'rationale', 'payload'],
        },
      },
    },
    required: ['archetype', 'brief', 'actions'],
  },
};

/**
 * Strategy Engine — the strategist brain. A bounded Claude tool-loop (cloned from
 * research-worker) that researches the market/audience/competitors via the shared
 * RESEARCH_TOOLS, then submits ONE strategy: the classified archetype, a
 * zod-validated brief, and a prioritized ActionPlan. On a valid brief it UPSERTs
 * the workspace's single MarketingStrategy (ACTIVE, version-bumped on replace)
 * and (re)inserts its StrategyActions (PROPOSED). Every run is one AgentRun;
 * firecrawl/apify money meters into the RESEARCH budget; hard caps + a reserved
 * `strategy.synthesize` credit ceiling bound each run's spend. Inert when sources
 * or the AI are unconfigured; refunds the reserve on failure.
 */
@Injectable()
export class StrategySynthesisService {
  private readonly logger = new Logger(StrategySynthesisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
    private readonly runs: AgentRunService,
    private readonly sources: ResearchSourcesService,
    private readonly spend: ResearchSpendService,
    private readonly orchestrator: StrategyOrchestrator,
    private readonly provisioning: StrategyProvisioningService,
  ) {}

  /**
   * Take a strategy an already-connected Claude wrote ITSELF, and store it
   * through the same writer synthesis uses.
   *
   * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
   *
   * Every route to a MarketingStrategy row ran through `synthesize()`, which
   * needs a StrategyIntakeSession and returns `{skipped:'ai-not-configured'}`
   * unless `AnthropicService.isEnabled()`. The intake wizard that produces the
   * session has the same gate. So on a platform whose own Anthropic key is out
   * of credit, a workspace with no strategy cannot obtain one by any path in
   * the product — measured live, with the vendor's "credit balance is too low"
   * coming back out of the nightly research run for over a week.
   *
   * The caller here IS the strategist. Asking it to ask the server to ask
   * another model buys nothing, costs `strategy.synthesize` + a
   * `strategy.turn` per iteration, and fails exactly when the platform key is
   * dry. `ContentConceptsService.submitConcepts` established this pair for
   * content; this is the same trade for the brain.
   *
   * ── WHAT IS DELIBERATELY NOT RELAXED ────────────────────────────────────
   *
   * The zod brief contract, the action normalization and `persist()` itself —
   * the same code on the same path, so the row a submit writes is the row a
   * synthesis writes: ACTIVE, version 1, `autonomyLevel` left to the DB default
   * of ASSISTED, actions PROPOSED, and the closing touch that keeps the weekly
   * feedback gate able to tell a fresh plan from a moved one. Every existing
   * reader (the console, the orchestrator, `WorkspaceReadinessService`) was
   * written against that row and none of them can tell the two apart.
   *
   * Two things are TIGHTER than synthesis, both because a submit is free to
   * retry while a mid-loop refusal throws away a paid research run:
   *  - an unrecognised archetype is REFUSED, not coerced to `OTHER` (that
   *    coercion silently swaps the channel priors the whole engine reads);
   *  - an ActionPlan that is empty, or whose every item was dropped, is
   *    REFUSED — the strategist prompt's own rule ("the ActionPlan is
   *    REQUIRED, never empty: it is what the operator approves and the system
   *    executes"), which synthesis can only ask for by bouncing the model.
   *
   * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────
   *
   * REPLACE. The synthesis writer `persist()` re-seeds the plan with a
   * `deleteMany` that is not filtered by status, so writing over a live
   * strategy destroys every StrategyAction of it — the DONE rows and their
   * `resultRef`s included, which are the only link from an action to the
   * research run or staged post it produced. So this creates the FIRST strategy
   * and refuses a second; replacing one stays with
   * `POST /marketing/strategy/refresh` and `jeeta.synthesize_strategy`.
   *
   * WHAT ENFORCES THAT IS THE DATABASE, not the read at the top of this method.
   * `MarketingStrategy.workspaceId` is `@unique` (schema.prisma) and
   * `createFirst()` writes with `create`, so a second row is refused by the
   * constraint even when the pre-check ran against a workspace that had none.
   * The pre-check is kept only because it can name the version and status of
   * the row it found; the P2002 it races with raises the same refusal, from
   * `alreadyHasStrategy()`.
   *
   * Nothing about the risk class does this work. What gates a tool at all is
   * `requiresApproval`, which `jeeta.submit_strategy` sets to false; the risk
   * class only decides whether `writeMode: 'AUTONOMOUS'` may bypass a gate that
   * exists, and `ALWAYS_APPROVED_RISKS` (mcp-broker.service.ts) holds
   * `DESTRUCTIVE` alone — so in that mode even the `SPEND` tools run inline.
   * There is no class-based protection standing behind this write.
   *
   * It also never calls `applyPlan`: a row it just created is ASSISTED, for
   * which `applyPlan` is a no-op anyway, and an AUTONOMOUS workspace is picked
   * up by the hourly `strategy-apply-tick` cron. Nothing here executes, so
   * "this spends nothing" is a fact about the code rather than about a lane
   * value.
   *
   * No credit is reserved, because none is spent: the thinking happened in the
   * caller's own context, on the caller's own subscription.
   *
   * ── WHAT THE CALLER GIVES UP ────────────────────────────────────────────
   *
   * A REFRESH. This writes no StrategyIntakeSession, and
   * `StrategyFeedbackService.refresh` — what `POST /marketing/strategy/refresh`,
   * `jeeta.synthesize_strategy` and the weekly `StrategyFeedbackCron` all call —
   * returns `{skipped:'no-intake-session'}` when the workspace has none. So
   * unless someone has run the panel's strategy interview at some point, a
   * strategy created here cannot be re-synthesized by any of the three, and no
   * endpoint edits a stored brief either. Revising it means running that
   * interview (which needs the platform's Anthropic key — the thing that was
   * unavailable when this path was wanted). Deliberately not papered over by
   * writing a session here: a fabricated intake would hand the strategist an
   * auto-analysis and interview answers nobody gave.
   *
   * CONCURRENCY: this takes no advisory lock, and neither do most of the other
   * writers of this row — `POST /marketing/strategy/intake/finish` calls
   * `synthesize` directly, and `jeeta.synthesize_strategy` calls
   * `feedback.refresh` directly. Only `POST /marketing/strategy/refresh` (a
   * `pg_try_advisory_xact_lock`) and the weekly feedback cron
   * (`withAdvisoryLock`, which serializes the cron against itself) hold one.
   * A synthesis run is bounded by MAX_WALL_MS — minutes — so the window in
   * which this method's pre-check can go stale is minutes, not seconds. That is
   * survivable only because the check is not what refuses: the loser of any
   * such race hits the unique index and is told so, with the winner's plan
   * untouched.
   */
  async submitStrategy(
    workspaceId: string,
    submission: { archetype?: unknown; brief?: unknown; actions?: unknown },
  ): Promise<StrategySubmitResult> {
    // Not the guarantee — the MESSAGE. The guarantee is the unique index that
    // `createFirst()` writes against; this read exists so the common refusal
    // can say which strategy is in the way. See the docblock above.
    const existing = await this.prisma.marketingStrategy.findUnique({ where: { workspaceId } });
    if (existing) throw this.alreadyHasStrategy(existing as { version?: number; status?: string });

    const check = validateBrief(submission.brief);
    if (!check.ok) {
      // The same sentence synthesis raises, so both paths report a bad brief in
      // one language.
      throw new BadRequestException(`invalid strategy brief: ${(check as { error: string }).error}`);
    }

    const archetype = String(submission.archetype ?? '');
    if (!(archetype in ARCHETYPES)) {
      throw new BadRequestException(
        `unknown archetype "${archetype}". Pick the closest of: ${Object.keys(ARCHETYPES).join(', ')}.`,
      );
    }

    const submitted = Array.isArray(submission.actions) ? submission.actions.length : 0;
    const actions = this.normalizeActions(submission.actions);
    if (!actions.length) {
      throw new BadRequestException(
        submitted
          ? `every one of the ${submitted} submitted actions was rejected. Each needs a kind of ` +
            `LEAD_HUNT | CONTENT | CHANNEL_SETUP | AD_CAMPAIGN | COMMUNITY_ENGAGE, plus a title and a rationale.`
          : 'the ActionPlan is required and cannot be empty — it is what the operator approves and the system executes.',
      );
    }

    const { strategyId, actionCount } = await this.createFirst(
      workspaceId,
      archetype as BusinessArchetype,
      check.brief,
      actions,
    );

    // Same best-effort provisioning synthesis does, for the same reason: by the
    // time a brief exists the system knows the product, voice and audience
    // better than a first-run user can type them. Creates ONE agent, only when
    // the workspace has none, and never fails the submit.
    await this.provisioning.ensureDefaultAgent(workspaceId, check.brief).catch((e) => {
      this.logger.warn(`submitStrategy: ensureDefaultAgent failed (ws ${workspaceId}): ${(e as Error)?.message ?? e}`);
    });

    this.logger.log(
      `strategy submitted by a connected agent: ${archetype} + ${actionCount} actions (ws ${workspaceId})`,
    );
    // `droppedActions` is reported rather than swallowed: normalization is
    // silent by design, and an agent told "12 actions" that saved 9 has no way
    // to notice.
    return { strategyId, actionCount, droppedActions: Math.max(0, submitted - actionCount) };
  }

  /**
   * @param extraContext optional outcome summary from the living feedback loop —
   *   folded into the strategist prompt so a re-synthesis adapts to what the
   *   previous plan's execution actually produced.
   */
  async synthesize(workspaceId: string, sessionId: string, extraContext?: string): Promise<StrategySynthesisResult> {
    // AI is the ONLY hard requirement. Research sources (firecrawl/apify) merely
    // ENHANCE the synthesis with live market research — without them the strategist
    // still produces a strategy from the intake auto-analysis + interview answers.
    // (Gating on sources here is what left prod unable to create ANY strategy when
    // firecrawl/apify keys weren't wired — the interview ran, but finish always
    // "skipped".)
    if (!this.anthropic.isEnabled()) return { strategyId: null, actionCount: 0, skipped: 'ai-not-configured' };
    const researchEnabled = this.sources.isEnabled();

    const session = await this.prisma.strategyIntakeSession.findFirst({ where: { id: sessionId, workspaceId } });
    if (!session) throw new NotFoundException('intake session not found');

    // The workspace's Brand Brain, when it exists, OUTRANKS the intake session.
    // The session is a snapshot — an auto-analysis of whatever the crawler saw
    // plus interview answers, both frozen at intake time — while the brand
    // profile is the owner-maintained live definition of the business (the
    // whole product promise of "Marka Beyni" is that it shapes every piece of
    // AI output). Synthesizing without it produced strategies that contradicted
    // facts the owner had already corrected: wrong product mode, wrong prices,
    // channels the business never sold through. Found live on a customer
    // workspace whose re-synthesis repeated every mistake of v1 verbatim.
    const brandProfile = await this.prisma.brandProfile
      .findUnique({ where: { workspaceId } })
      .catch(() => null);

    return this.runs.track(
      workspaceId,
      { agent: 'strategy-synthesis', goal: 'Synthesize marketing strategy', input: { sessionId } },
      async (runId) => {
        // Base only. The expensive part is the tool-loop below and it is
        // charged PER TURN: a single flat per-run reserve priced one credit
        // amount for anywhere between one and MAX_ITERS Opus calls at
        // maxTokens 4000, so the credit ceiling was not a spend ceiling.
        await this.credits.reserve(workspaceId, creditCost('strategy.synthesize'));
        let turnsCharged = 0;
        let turnsCompleted = 0;
        try {
          const ctx: ResearchToolCtx = { workspaceId, runId, geo: {}, budgetId: null };
          const deps = { sources: this.sources, spend: this.spend, runs: this.runs };
          // Only offer the research tools when a source is actually configured —
          // otherwise the model would burn turns on tools that return nothing.
          const tools = researchEnabled ? [...RESEARCH_TOOLS, SUBMIT_STRATEGY_TOOL] : [SUBMIT_STRATEGY_TOOL];
          const messages: Anthropic.MessageParam[] = [
            { role: 'user', content: this.buildBrief(session, extraContext, researchEnabled, brandProfile) },
          ];

          let submission: { archetype?: unknown; brief?: unknown; actions?: unknown } | null = null;
          let toolCalls = 0;
          // One bounce, not a loop: an empty ActionPlan is almost always the
          // model treating actions as optional (both live syntheses for the
          // first customer workspace submitted a full brief + zero actions,
          // leaving the strategy console with nothing to approve). Push back
          // once with an instructive tool_result; if the resubmission is STILL
          // empty, accept it — a brief without a plan beats a hard failure,
          // and the model has by then twice judged no action worth proposing.
          let emptyPlanBounced = false;
          const deadline = Date.now() + MAX_WALL_MS;

          for (let i = 0; i < MAX_ITERS && Date.now() < deadline && toolCalls < MAX_TOOL_CALLS; i++) {
            // Charge before the call, not after: an exhausted workspace must
            // stop spending Jeeta's money, not discover the limit afterwards.
            // Letting this throw is deliberate — the caller gets a truthful
            // AI_CREDITS_EXHAUSTED rather than "synthesis produced no strategy".
            await this.credits.reserve(workspaceId, creditCost('strategy.turn'));
            turnsCharged += 1;
            const res = await this.anthropic.complete({
              system: this.SYSTEM,
              messages,
              tools,
              // 8000, not 4000: submit_strategy emits the archetype + a COMPLETE
              // brief + the ActionPlan in ONE tool call, and a thorough brief
              // alone can approach 4k output tokens. At the old cap the model
              // visibly self-rationed — it closed the JSON with "actions": []
              // to fit, and the empty-plan bounce could not help because the
              // resubmission faced the same budget. (Live: two consecutive
              // syntheses produced rich briefs + raw=0 actions.)
              maxTokens: 8000,
              tier: tierFor('strategy.turn'), workspaceId: workspaceId, action: 'strategy.turn',
              cacheSystem: true,
            });
            turnsCompleted += 1;
            if (!res.toolUses.length) break;

            const results: Anthropic.ToolResultBlockParam[] = [];
            let submitted = false;
            for (const tu of res.toolUses) {
              if (tu.name === 'submit_strategy') {
                const candidate = (tu.input ?? {}) as typeof submission;
                const rawCount = Array.isArray(candidate?.actions) ? candidate.actions.length : 0;
                const normalized = this.normalizeActions(candidate?.actions);
                // Two distinct failure shapes hide behind "0 actions": the model
                // genuinely proposed none, or it proposed several and every one
                // was silently dropped (invalid kind / missing title/rationale).
                // The bounce must name which — "your plan is empty" to a model
                // that just sent 6 items teaches it nothing, and the log line is
                // how prod tells us which case actually happened.
                if (normalized.length === 0 && rawCount > 0) {
                  this.logger.warn(
                    `strategy synthesis ${runId}: ${rawCount} submitted action(s) ALL dropped by normalization (ws ${workspaceId}) — first raw kind: ${JSON.stringify((candidate!.actions as unknown[])[0])?.slice(0, 300)}`,
                  );
                }
                if (!emptyPlanBounced && normalized.length === 0) {
                  emptyPlanBounced = true;
                  this.logger.log(
                    `strategy synthesis ${runId}: bouncing empty ActionPlan (raw=${rawCount}) back to the model (ws ${workspaceId})`,
                  );
                  results.push({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: JSON.stringify({
                      received: false,
                      error:
                        rawCount > 0
                          ? `You submitted ${rawCount} action(s) but EVERY one was rejected. Each action MUST have: kind — exactly one of LEAD_HUNT | CONTENT | CHANNEL_SETUP | AD_CAMPAIGN | COMMUNITY_ENGAGE (no other value is accepted) — plus a non-empty title AND a non-empty rationale. Example: {"kind":"CONTENT","title":"Reveal reel: photo to figure","rationale":"Kills the likeness objection with proof","priority":"HIGH","payload":{"channelKey":"instagram"}}. Re-submit the SAME strategy with your actions corrected to this shape.`
                          : 'Your ActionPlan is empty. The plan is what the operator approves and the system executes — a strategy without one changes nothing. Re-submit the SAME strategy WITH 3-8 prioritized actions (kind ∈ LEAD_HUNT | CONTENT | CHANNEL_SETUP | AD_CAMPAIGN | COMMUNITY_ENGAGE, each with title + rationale) covering your highest-fit channels; include at least one they can start this week.',
                    }),
                  });
                  continue;
                }
                submission = candidate;
                results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ received: true }) });
                submitted = true;
              } else {
                toolCalls += 1;
                const out = await dispatchResearchTool(deps, ctx, tu.name, (tu.input ?? {}) as Record<string, unknown>);
                results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 8000) });
              }
            }
            messages.push({ role: 'assistant', content: res.toolUses as Anthropic.ContentBlockParam[] });
            messages.push({ role: 'user', content: results });
            if (submitted) break;
          }

          if (!submission) throw new Error('synthesis produced no strategy');

          const check = validateBrief(submission.brief);
          if (!check.ok) {
            throw new Error(`invalid strategy brief: ${(check as { error: string }).error}`);
          }

          const archetype = validArchetype(submission.archetype);
          const actions = this.normalizeActions(submission.actions);

          const { strategyId, actionCount } = await this.persist(workspaceId, archetype, check.brief, actions);

          // The strategy builds the workspace's default agent itself — the
          // brief already knows the product, voice and audience better than a
          // first-run user can type them. Best-effort: never fails synthesis.
          await this.provisioning.ensureDefaultAgent(workspaceId, check.brief);
          await this.prisma.strategyIntakeSession
            .updateMany({ where: { id: sessionId, workspaceId }, data: { status: 'COMPLETE' } })
            .catch(() => undefined);

          // Autonomy hook: hand the freshly-seeded PROPOSED plan to the lane-aware
          // orchestrator. A no-op for SHADOW/ASSISTED (the common path); only an
          // AUTONOMOUS workspace with the env kill-switch on auto-executes here.
          // Never fail the synthesis on an apply error.
          await this.orchestrator.applyPlan(workspaceId).catch((e) => {
            this.logger.error(`strategy synthesis ${runId}: applyPlan failed (ws ${workspaceId}): ${(e as Error)?.message ?? e}`);
          });

          this.logger.log(`strategy synthesis ${runId}: ${archetype} + ${actionCount} actions (ws ${workspaceId})`);
          return { strategyId, actionCount };
        } catch (e) {
          // Refund the base and only the turn that did NOT run.
          // Turns whose Anthropic call actually RETURNED are real vendor spend
          // and must stay charged. Refunding them let a workspace sitting just
          // under its cap replay the loop for free: charge a turn, execute it,
          // hit AI_CREDITS_EXHAUSTED on the next one, get everything back.

          await this.credits
            .refund(
              workspaceId,
              creditCost('strategy.synthesize') +
                Math.max(0, turnsCharged - turnsCompleted) * creditCost('strategy.turn'),
            )
            .catch(() => undefined);
          throw e;
        }
      },
    );
  }

  /**
   * The ONE refusal that keeps a submit from destroying a live plan. Raised
   * from two places on purpose — `submitStrategy`'s pre-check, which has read
   * the row and can name it, and `createFirst`'s P2002 handler, which has not —
   * so the caller sees one behaviour whichever way it is refused.
   */
  private alreadyHasStrategy(existing: { version?: number; status?: string } | null): BadRequestException {
    const which = existing ? ` (v${existing.version ?? '?'}, ${existing.status ?? '?'})` : '';
    return new BadRequestException(
      `This workspace already has a strategy${which}. ` +
        'Submitting over it would delete its whole ActionPlan, including the DONE actions whose resultRefs are ' +
        'the only link to the research runs and posts they produced. Read it with jeeta.get_strategy. Replacing a ' +
        'strategy is jeeta.synthesize_strategy, which re-synthesizes FROM the intake session — so it works on a ' +
        'workspace that ran the panel interview, and answers {skipped:\'no-intake-session\'} on one whose strategy ' +
        'was submitted through this tool. There, rewriting the brief means running that interview in the panel.',
    );
  }

  /**
   * The unique-constraint violation a second `MarketingStrategy` row raises.
   *
   * Matched on `code`, the same shape `meta-leadgen-ingest.service.ts` matches,
   * rather than `instanceof Prisma.PrismaClientKnownRequestError` — so the
   * interleaving this guards can be simulated in a spec without constructing a
   * Prisma error class.
   *
   * Not narrowed to a column, unlike `ai-credit-wallet.service.ts`'s
   * `isRefConflict`: that write touches two unique columns and a blanket catch
   * there loses money, whereas `MarketingStrategy` declares exactly one unique
   * index besides its primary key — `workspaceId @unique` (schema.prisma) — and
   * `createFirst` supplies no id.
   */
  private isDuplicateStrategy(e: unknown): boolean {
    return (e as { code?: string } | null | undefined)?.code === 'P2002';
  }

  /**
   * The SUBMIT writer: create the workspace's FIRST strategy and seed its plan.
   *
   * Split from `persist()` for one reason — it CREATES where persist upserts,
   * which is what makes "a submit never overwrites an existing strategy" a
   * database guarantee instead of a promise made by a read that ran earlier.
   * Everything else is held identical to persist deliberately, because every
   * reader (the console, the orchestrator, the weekly feedback gate, the
   * readiness list) was written against the row synthesis produces: the same
   * ACTIVE/version-1/archetype/brief fields, `autonomyLevel` left to the DB
   * default of ASSISTED, the same `actionRows()` at status PROPOSED, and the
   * same closing touch so the row ends up strictly newer than its actions.
   *
   * The row and its actions go in ONE transaction here, where persist brackets
   * them (there, the strategy is upserted before the actions and touched after,
   * so its `updatedAt` brackets them instead of sharing their commit — see
   * persist()'s own note on the lock its callers must hold for that to hold).
   * A submit has no previous plan to protect and exactly one shot at the row:
   * if seeding the actions failed after the row had landed, the create-only
   * refusal above would then lock the workspace into a strategy with no plan
   * and no way back through this tool. Wrapped, a failed submit leaves nothing
   * behind and can simply be retried.
   */
  private async createFirst(
    workspaceId: string,
    archetype: BusinessArchetype,
    brief: object,
    actions: StrategyActionItem[],
  ): Promise<{ strategyId: string; actionCount: number }> {
    const strategyId = await this.prisma
      .$transaction(async (tx) => {
        const strategy = await tx.marketingStrategy.create({
          data: { workspaceId, status: 'ACTIVE', archetype, brief: brief as any, version: 1 },
        });
        if (actions.length) {
          await tx.strategyAction.createMany({ data: this.actionRows(workspaceId, strategy.id, actions) });
        }
        return strategy.id;
      })
      .catch((e) => {
        // The race the pre-check cannot win: another submit, or an intake
        // `finish` / `feedback.refresh` synthesis, wrote the row in the minutes
        // since. The transaction rolled back, so the winner's plan is untouched
        // and this caller is told the same thing the pre-check would have said.
        if (this.isDuplicateStrategy(e)) throw this.alreadyHasStrategy(null);
        throw e;
      });

    // Touch the strategy LAST, after its actions exist — the same ordering
    // persist() documents at length: the weekly feedback cron skips a workspace
    // unless a StrategyAction has an `updatedAt` GREATER than the strategy's,
    // so a fresh plan must leave the strategy the newer row. Both writes above
    // are in one transaction, which is why establishing that is this separate
    // update's job rather than a side effect of the create.
    await this.prisma.marketingStrategy.update({ where: { id: strategyId }, data: { status: 'ACTIVE' } });

    return { strategyId, actionCount: actions.length };
  }

  /** The StrategyAction rows one plan becomes. Shared by both writers so a
   *  submitted plan and a synthesized one cannot drift apart in shape. */
  private actionRows(workspaceId: string, strategyId: string, actions: StrategyActionItem[]) {
    return actions.map((a) => ({
      workspaceId,
      strategyId,
      kind: a.kind,
      title: a.title,
      rationale: a.rationale,
      payload: a.payload as any,
      priority: a.priority,
      status: 'PROPOSED',
    }));
  }

  /** Upsert the workspace's single strategy (ACTIVE, version-bumped on replace)
   *  and re-seed its ActionPlan (drop prior PROPOSED plan, insert the new one).
   *  This is the SYNTHESIS writer; `jeeta.submit_strategy` goes through
   *  `createFirst()` instead, which cannot replace anything.
   *
   *  The strategy row is TOUCHED LAST, after its actions exist. The weekly
   *  feedback cron decides whether anything is worth re-synthesizing by asking
   *  "has a StrategyAction moved since the strategy was written?" — and writing
   *  the strategy first made every freshly-seeded action newer than it, so the
   *  answer was always yes and the gate never skipped a single workspace.
   *
   *  That ordering only survives if ONE synthesis runs at a time per workspace,
   *  which this method does not and cannot arrange for itself: the callers hold
   *  the lock. POST /strategy/refresh takes a per-workspace
   *  `pg_try_advisory_xact_lock` around the whole run; the weekly cron is
   *  already serialized by `withAdvisoryLock`. Two concurrent runs would
   *  interleave into one strategy holding both plans, and could land the
   *  closing strategy write before the other run's actions — re-opening exactly
   *  the gate the paragraph above is about. */
  private async persist(
    workspaceId: string,
    archetype: BusinessArchetype,
    brief: object,
    actions: StrategyActionItem[],
  ): Promise<{ strategyId: string; actionCount: number }> {
    const strategy = await this.prisma.marketingStrategy.upsert({
      where: { workspaceId },
      create: { workspaceId, status: 'ACTIVE', archetype, brief: brief as any, version: 1 },
      update: { status: 'ACTIVE', archetype, brief: brief as any, version: { increment: 1 } },
    });

    // The drop and the re-seed are ONE transaction, because between them the
    // workspace has no plan at all. This is not a hypothetical window: the
    // console polls the plan, the orchestrator reads it to decide what to run,
    // and the weekly cron counts action rows — every one of them can land in
    // the gap and see a strategy with zero actions, which reads as "the AI
    // produced nothing" rather than "ask again in a second". Worse, a failure
    // in createMany (a bad payload, a lost connection) used to LEAVE it that
    // way: the old plan already deleted, the new one never inserted, and the
    // only record of what the workspace had been doing gone with it — including
    // the DONE rows' resultRefs, which are the sole link from an action to the
    // research run or staged post it produced. Wrapped, a half-replaced plan is
    // never observable and a failed replace is a no-op.
    //
    // The strategy row is deliberately NOT inside this transaction. It is
    // upserted before and touched after, so that its `updatedAt` brackets the
    // actions rather than sharing their commit — see the comment below for why
    // that ordering is load-bearing.
    await this.prisma.$transaction(async (tx) => {
      await tx.strategyAction.deleteMany({ where: { workspaceId, strategyId: strategy.id } });
      if (actions.length) {
        await tx.strategyAction.createMany({ data: this.actionRows(workspaceId, strategy.id, actions) });
      }
    });

    // Touch the strategy LAST, so it is strictly newer than the actions it just
    // seeded. The weekly feedback cron asks "has any StrategyAction moved since
    // the strategy was written?" — with the strategy written first, every fresh
    // action was newer than it, the answer was always yes, and the gate skipped
    // nobody. That put a full Opus re-synthesis plus live crawl spend on every
    // ACTIVE strategy every week, including workspaces nobody had touched.
    await this.prisma.marketingStrategy.update({
      where: { id: strategy.id },
      data: { status: 'ACTIVE' },
    });

    return { strategyId: strategy.id, actionCount: actions.length };
  }

  /** Keep only well-formed, typed ActionPlan items (executor-ready). */
  private normalizeActions(raw: unknown): StrategyActionItem[] {
    if (!Array.isArray(raw)) return [];
    const out: StrategyActionItem[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const a = r as Record<string, unknown>;
      const kind = String(a.kind ?? '').trim().toUpperCase();
      const title = String(a.title ?? '').trim();
      const rationale = String(a.rationale ?? '').trim();
      if (!ACTION_KINDS.has(kind) || !title || !rationale) continue;
      const priority = typeof a.priority === 'string' && PRIORITIES.has(a.priority) ? a.priority : 'MEDIUM';
      const payload = a.payload && typeof a.payload === 'object' ? (a.payload as Record<string, unknown>) : {};
      out.push({ kind: kind as ActionKind, title: title.slice(0, 200), rationale: rationale.slice(0, 2000), payload, priority: priority as StrategyActionItem['priority'] });
      if (out.length >= MAX_ACTIONS) break;
    }
    return out;
  }

  private buildBrief(
    session: { autoAnalysis: unknown; transcript: unknown },
    extraContext?: string,
    researchEnabled = true,
    brandProfile?: Record<string, unknown> | null,
  ): string {
    const qa = extractQa(session.transcript);
    // Owner-maintained fact sheet. Serialized compactly and capped: the
    // strategist needs the facts, not a token flood — 6000 chars comfortably
    // holds a fully-filled profile while bounding the prompt.
    const brand = brandProfile
      ? JSON.stringify({
          brandName: brandProfile.brandName,
          tagline: brandProfile.tagline,
          description: brandProfile.description,
          valueProps: brandProfile.valueProps,
          toneWords: brandProfile.toneWords,
          voiceGuide: brandProfile.voiceGuide,
          icpDescription: brandProfile.icpDescription,
          audienceObjections: brandProfile.audienceObjections,
          offerings: brandProfile.offerings,
        }).slice(0, 6000)
      : '';
    const closing = researchEnabled
      ? 'Research the market/audience/competitors with the tools, then call submit_strategy with the archetype, a COMPLETE brief, and a prioritized ActionPlan.'
      : 'Research tools are unavailable in this workspace — synthesize directly from the auto-analysis and interview answers above (use your own market knowledge to fill gaps), then call submit_strategy with the archetype, a COMPLETE brief, and a prioritized ActionPlan.';
    return [
      brand
        ? `BRAND PROFILE (owner-maintained ground truth — where it conflicts with the auto-analysis or interview below, the BRAND PROFILE wins; it is newer and owner-confirmed): ${brand}`
        : '',
      `AUTO-ANALYSIS: ${JSON.stringify(session.autoAnalysis ?? {})}`,
      this.priorsLine(session.autoAnalysis),
      qa ? `INTERVIEW (operator answers):\n${qa}` : '',
      extraContext ? extraContext.trim() : '',
      closing,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** When the intake auto-analysis already suggested an archetype, thread its
   *  registry priors (channel fit-scores + the archetype-specific interview
   *  angles) into the strategist prompt as a STARTING point to adjust with
   *  research — not a hard constraint. */
  private priorsLine(autoAnalysis: unknown): string {
    const suggested = (autoAnalysis as { suggestedArchetype?: unknown } | null)?.suggestedArchetype;
    if (typeof suggested !== 'string' || !(suggested in ARCHETYPES)) return '';
    const meta = archetypeMeta(suggested as BusinessArchetype);
    return [
      `PRIORS (suggested archetype ${suggested}, adjust with research):`,
      `- channel fit priors: ${JSON.stringify(meta.channelPriors)}`,
      meta.interviewDeltas.length ? `- archetype angles to probe: ${meta.interviewDeltas.join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private readonly SYSTEM =
    'You are a senior marketing strategist inside a multi-tenant marketing-automation platform. ' +
    'Research the market, audience and competitors with the tools, then submit ONE strategy via submit_strategy. ' +
    'Classify the business into exactly one BusinessArchetype key (e.g. B2B_LOCAL_SERVICE, B2B_SAAS, B2C_ECOMMERCE, B2C_COMMUNITY_NICHE, CREATOR_MEDIA, LOCAL_RETAIL_FOOD, OTHER). ' +
    'Produce a COMPLETE but CONCISE brief: identity (product/voice/positioning/usp), audience (ICP), channels (key + 0-1 fitScore + rationale), contentPillars (title/angle/formats/tone), goals (objective + kpis), budget, competitors. Keep every field tight — the brief is read in a panel, not published — and always reserve enough output budget to finish the ActionPlan; a strategy that spends everything on prose and submits an empty plan is a failed submission. ' +
    'Then a prioritized ActionPlan of typed StrategyAction items (kind ∈ LEAD_HUNT|CONTENT|CHANNEL_SETUP|AD_CAMPAIGN|COMMUNITY_ENGAGE) with executor-ready payloads — the ActionPlan is REQUIRED, never empty: it is what the operator approves and the system executes. ' +
    'When a BRAND PROFILE is supplied, treat it as owner-confirmed fact: on any conflict with the auto-analysis, the interview or your own research, the BRAND PROFILE wins (it is newer, and the owner wrote it). Pay particular attention to its stated prices, product modes and to any channel the owner says has actually produced sales. ' +
    'If PRIORS are supplied for a suggested archetype, START from those channel fit-scores and probe angles, then adjust them with what your research finds. ' +
    'Be archetype-adaptive in HOW you drive growth: ' +
    'a B2B business (leadApproach B2B_PROSPECT) grows by prospecting named accounts — favour LEAD_HUNT actions on channels like linkedin/email/google-maps. ' +
    'a B2C / community / creator business (leadApproach B2C_AUDIENCE) grows by becoming native in the communities its audience already inhabits — favour COMMUNITY_ENGAGE + CONTENT over outbound. ' +
    'For a B2C_COMMUNITY_NICHE / B2C_ECOMMERCE / CREATOR_MEDIA business you MUST use the research tools to DISCOVER the SPECIFIC communities the audience gathers in — name the actual subreddits, Discord servers, forums, and niche platforms (do not guess a generic channel) — and the content FORMATS that resonate there (memes, tutorials, clips, guides). ' +
    'Write each discovered community into brief.channels with a channel key (reddit, discord, forum, youtube, tiktok, x) and name the SPECIFIC community in that channel rationale (e.g. rationale "r/<subreddit> is where they gather"). ' +
    'Write channel-native brief.contentPillars whose angle+tone match each community (e.g. a meme pillar for a Reddit community, a tutorial pillar for a Discord/forum). ' +
    'Emit COMMUNITY_ENGAGE actions, one per community post idea, with payload { channelKey, community, title, angle, tone, format } — channelKey is the channel key, community is the specific subreddit/server/forum, format is the native content format (meme/tutorial/clip). ' +
    'Call submit_strategy exactly once when done.';
}

function validArchetype(v: unknown): BusinessArchetype {
  return typeof v === 'string' && v in ARCHETYPES ? (v as BusinessArchetype) : 'OTHER';
}

/** Render the interview Q&A log stored on the transcript into readable text. */
function extractQa(transcript: unknown): string {
  const t = (transcript ?? {}) as { qa?: Array<{ questions?: unknown; answers?: unknown }> };
  if (!Array.isArray(t.qa) || !t.qa.length) return '';
  const lines: string[] = [];
  for (const entry of t.qa) {
    const qs = Array.isArray(entry.questions) ? entry.questions : [];
    const as = Array.isArray(entry.answers) ? entry.answers : [];
    qs.forEach((q, i) => {
      lines.push(`Q: ${String(q)}`);
      if (as[i] != null) lines.push(`A: ${String(as[i])}`);
    });
  }
  return lines.join('\n');
}
