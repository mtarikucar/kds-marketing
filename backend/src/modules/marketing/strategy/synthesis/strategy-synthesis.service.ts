import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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

const MAX_ITERS = 10;
const MAX_TOOL_CALLS = 24;
const MAX_WALL_MS = Number(process.env.STRATEGY_SYNTH_MAX_MS ?? 180_000);
const MAX_ACTIONS = 24;
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

  /** Upsert the workspace's single strategy (ACTIVE, version-bumped on replace)
   *  and re-seed its ActionPlan (drop prior PROPOSED plan, insert the new one).
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
        await tx.strategyAction.createMany({
          data: actions.map((a) => ({
            workspaceId,
            strategyId: strategy.id,
            kind: a.kind,
            title: a.title,
            rationale: a.rationale,
            payload: a.payload as any,
            priority: a.priority,
            status: 'PROPOSED',
          })),
        });
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
