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
  ) {}

  /**
   * @param extraContext optional outcome summary from the living feedback loop —
   *   folded into the strategist prompt so a re-synthesis adapts to what the
   *   previous plan's execution actually produced.
   */
  async synthesize(workspaceId: string, sessionId: string, extraContext?: string): Promise<StrategySynthesisResult> {
    if (!this.sources.isEnabled()) return { strategyId: null, actionCount: 0, skipped: 'sources-not-configured' };
    if (!this.anthropic.isEnabled()) return { strategyId: null, actionCount: 0, skipped: 'ai-not-configured' };

    const session = await this.prisma.strategyIntakeSession.findFirst({ where: { id: sessionId, workspaceId } });
    if (!session) throw new NotFoundException('intake session not found');

    return this.runs.track(
      workspaceId,
      { agent: 'strategy-synthesis', goal: 'Synthesize marketing strategy', input: { sessionId } },
      async (runId) => {
        await this.credits.reserve(workspaceId, creditCost('strategy.synthesize'));
        try {
          const ctx: ResearchToolCtx = { workspaceId, runId, geo: {}, budgetId: null };
          const deps = { sources: this.sources, spend: this.spend, runs: this.runs };
          const tools = [...RESEARCH_TOOLS, SUBMIT_STRATEGY_TOOL];
          const messages: Anthropic.MessageParam[] = [{ role: 'user', content: this.buildBrief(session, extraContext) }];

          let submission: { archetype?: unknown; brief?: unknown; actions?: unknown } | null = null;
          let toolCalls = 0;
          const deadline = Date.now() + MAX_WALL_MS;

          for (let i = 0; i < MAX_ITERS && Date.now() < deadline && toolCalls < MAX_TOOL_CALLS; i++) {
            const res = await this.anthropic.complete({
              system: this.SYSTEM,
              messages,
              tools,
              maxTokens: 4000,
              tier: tierFor('strategy.synthesize'),
              cacheSystem: true,
            });
            if (!res.toolUses.length) break;

            const results: Anthropic.ToolResultBlockParam[] = [];
            let submitted = false;
            for (const tu of res.toolUses) {
              if (tu.name === 'submit_strategy') {
                submission = (tu.input ?? {}) as typeof submission;
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
          await this.credits.refund(workspaceId, creditCost('strategy.synthesize')).catch(() => undefined);
          throw e;
        }
      },
    );
  }

  /** Upsert the workspace's single strategy (ACTIVE, version-bumped on replace)
   *  and re-seed its ActionPlan (drop prior PROPOSED plan, insert the new one). */
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

    await this.prisma.strategyAction.deleteMany({ where: { workspaceId, strategyId: strategy.id } });
    if (actions.length) {
      await this.prisma.strategyAction.createMany({
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

  private buildBrief(session: { autoAnalysis: unknown; transcript: unknown }, extraContext?: string): string {
    const qa = extractQa(session.transcript);
    return [
      `AUTO-ANALYSIS: ${JSON.stringify(session.autoAnalysis ?? {})}`,
      this.priorsLine(session.autoAnalysis),
      qa ? `INTERVIEW (operator answers):\n${qa}` : '',
      extraContext ? extraContext.trim() : '',
      'Research the market/audience/competitors with the tools, then call submit_strategy with the archetype, a COMPLETE brief, and a prioritized ActionPlan.',
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
    'Produce a COMPLETE brief: identity (product/voice/positioning/usp), audience (ICP), channels (key + 0-1 fitScore + rationale), contentPillars (title/angle/formats/tone), goals (objective + kpis), budget, competitors. ' +
    'Then a prioritized ActionPlan of typed StrategyAction items (kind ∈ LEAD_HUNT|CONTENT|CHANNEL_SETUP|AD_CAMPAIGN|COMMUNITY_ENGAGE) with executor-ready payloads. ' +
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
