import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AnthropicService } from '../../ai/anthropic.service';
import { AiCreditsService } from '../../ai/ai-credits.service';
import { creditCost, tierFor } from '../../ai/ai-credit-costs';
import { WebsiteBrandSource } from '../../brand-brain/sources/website.source';
import { SocialBrandSource } from '../../brand-brain/sources/social.source';
import { BrandSourceInput, BrandSourceResult } from '../../brand-brain/sources/brand-source';
import { ResearchSpendService } from '../../budget/research-spend.service';
import { BrandAnalysisService } from '../../brand-brain/brand-analysis.service';
import { ARCHETYPES, archetypeMeta } from '../archetypes';
import { BusinessArchetype } from '../strategy.types';

/** Hard cap on adaptive-interview turns (start = turn 1, each answer = +1). A
 *  bounded loop like research-worker — the model is told to finish sooner. */
const MAX_TURNS = 6;
const MAX_QUESTIONS = 6;

export interface StrategyIntakeInput {
  url?: string;
  socials?: Array<{ network: 'INSTAGRAM' | 'FACEBOOK' | 'LINKEDIN'; handle: string }>;
  oneLiner?: string;
}

/** The auto-analysis derived from the workspace's own url + socials. Persisted on
 *  the session and fed to both the interview and the synthesis brain. */
export interface StrategyAutoAnalysis {
  product: string | null;
  category: string | null;
  tone: string | null;
  suggestedArchetype: BusinessArchetype | null;
  sources: Array<{ source: string; status: string }>;
}

/** The turn-by-turn state persisted on `StrategyIntakeSession.transcript`. Holds
 *  the raw Anthropic message array (so the multi-request tool-loop can be
 *  resumed) plus a human-readable Q&A log for the synthesis brief. */
interface IntakeTranscript {
  messages: Anthropic.MessageParam[];
  qa: Array<{ questions: string[]; answers?: string[] }>;
  pendingAskId: string | null;
  turns: number;
  done: boolean;
}

export type StartResult =
  | { sessionId: string; questions: string[]; done?: boolean; autoAnalysis: StrategyAutoAnalysis }
  | { skipped: string };
export type AnswerResult = { questions: string[] } | { done: true } | { skipped: string };

const INTAKE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'ask_questions',
    description:
      'Ask the operator the next batch of short onboarding questions (1-6). Ask ONLY gaps not answered by the auto-analysis + the strategic intent (goal, audience specifics, budget, competitors, constraints, offer).',
    input_schema: {
      type: 'object',
      properties: { questions: { type: 'array', items: { type: 'string' } } },
      required: ['questions'],
    },
  },
  {
    name: 'intake_done',
    description: 'Call this exactly once when you have enough to synthesize a strategy — no more questions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

const ANALYSIS_TOOL: Anthropic.Tool[] = [
  {
    name: 'submit_analysis',
    description:
      'Finalize the auto-analysis: what the business sells (product), its category, its brand tone, and the single best-fit archetype key.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string' },
        category: { type: 'string' },
        tone: { type: 'string' },
        suggestedArchetype: { type: 'string', enum: Object.keys(ARCHETYPES) },
      },
      required: ['product'],
    },
  },
];

/**
 * Strategy Engine — hybrid onboarding. `start` runs an auto-analysis over the
 * workspace's own url + socials (reusing the Brand Brain source adapters) then
 * opens an adaptive AI interview that asks ONLY the gaps + strategic intent;
 * `answer` advances that bounded tool-loop until the model calls `intake_done`.
 * Each turn is one credit-metered (`strategy.interview`) Anthropic call, refunded
 * on failure. Inert (graceful skip) when the AI is not configured. Mirrors the
 * research-worker bounded-loop + reserve/refund shape.
 */
@Injectable()
export class StrategyIntakeService {
  private readonly logger = new Logger(StrategyIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
    private readonly website: WebsiteBrandSource,
    private readonly social: SocialBrandSource,
    private readonly spend: ResearchSpendService,
    private readonly brandAnalysis: BrandAnalysisService,
  ) {}

  async start(workspaceId: string, input: StrategyIntakeInput): Promise<StartResult> {
    if (!this.anthropic.isEnabled()) return { skipped: 'ai-not-configured' };

    const session = await this.prisma.strategyIntakeSession.create({
      data: { workspaceId, status: 'IN_PROGRESS', transcript: {} as any },
    });

    const cost = creditCost('strategy.interview');
    await this.credits.reserve(workspaceId, cost);
    try {
      const autoAnalysis = await this.autoAnalyze(workspaceId, input);

      // Brand Brain starts HERE, from the same material, in the background.
      // It used to be a separate checklist step the user had to find and run —
      // but the strategy intake already holds everything it needs (the site,
      // the socials), so asking again was pure demand. autoApply means the
      // finished draft seeds the brand profile, knowledge docs and research
      // profile on its own; all of it stays editable in its own pages.
      await this.startBrandBrain(workspaceId, input);

      const deltas = autoAnalysis.suggestedArchetype
        ? archetypeMeta(autoAnalysis.suggestedArchetype).interviewDeltas
        : [];

      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: this.buildKickoff(input, autoAnalysis) },
      ];
      const turn = await this.interviewTurn(messages, deltas);
      if (turn.toolUse) messages.push({ role: 'assistant', content: [turn.toolUse] });

      const transcript: IntakeTranscript = {
        messages,
        qa: turn.done ? [] : [{ questions: turn.questions }],
        pendingAskId: turn.done ? null : turn.toolUse?.id ?? null,
        turns: 1,
        done: turn.done,
      };
      await this.prisma.strategyIntakeSession.update({
        where: { id: session.id },
        data: {
          autoAnalysis: autoAnalysis as any,
          transcript: transcript as any,
          status: turn.done ? 'COMPLETE' : 'IN_PROGRESS',
        },
      });

      return {
        sessionId: session.id,
        questions: turn.questions,
        autoAnalysis,
        ...(turn.done ? { done: true } : {}),
      };
    } catch (e) {
      await this.credits.refund(workspaceId, cost).catch(() => undefined);
      throw e;
    }
  }

  async answer(workspaceId: string, sessionId: string, answers: string[]): Promise<AnswerResult> {
    if (!this.anthropic.isEnabled()) return { skipped: 'ai-not-configured' };

    const session = await this.prisma.strategyIntakeSession.findFirst({
      where: { id: sessionId, workspaceId },
    });
    if (!session) throw new NotFoundException('intake session not found');

    const t = (session.transcript ?? {}) as unknown as IntakeTranscript;
    if (t.done || session.status !== 'IN_PROGRESS') return { done: true };

    const messages: Anthropic.MessageParam[] = Array.isArray(t.messages) ? t.messages : [];
    const cleanAnswers = strArr(answers);
    // Answer the model's pending ask_questions tool_use so the loop can continue.
    if (t.pendingAskId) {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: t.pendingAskId, content: JSON.stringify({ answers: cleanAnswers }) }],
      });
    } else {
      messages.push({ role: 'user', content: `Operator answers: ${JSON.stringify(cleanAnswers)}` });
    }
    if (t.qa?.length) t.qa[t.qa.length - 1].answers = cleanAnswers;

    // Turn cap: once we've reached MAX_TURNS, finish without another AI call.
    if ((t.turns ?? 1) >= MAX_TURNS) {
      await this.persistTranscript(sessionId, { ...t, messages, pendingAskId: null, done: true }, true);
      return { done: true };
    }

    const cost = creditCost('strategy.interview');
    await this.credits.reserve(workspaceId, cost);
    try {
      const auto = (session.autoAnalysis ?? null) as unknown as StrategyAutoAnalysis | null;
      const deltas = auto?.suggestedArchetype ? archetypeMeta(auto.suggestedArchetype).interviewDeltas : [];
      const turn = await this.interviewTurn(messages, deltas);
      if (turn.toolUse) messages.push({ role: 'assistant', content: [turn.toolUse] });

      const nextTurns = (t.turns ?? 1) + 1;
      const done = turn.done || nextTurns >= MAX_TURNS;
      const qa = t.qa ?? [];
      if (!done) qa.push({ questions: turn.questions });

      await this.persistTranscript(
        sessionId,
        { messages, qa, pendingAskId: done ? null : turn.toolUse?.id ?? null, turns: nextTurns, done },
        done,
      );
      return done ? { done: true } : { questions: turn.questions };
    } catch (e) {
      await this.credits.refund(workspaceId, cost).catch(() => undefined);
      throw e;
    }
  }

  private async persistTranscript(sessionId: string, transcript: IntakeTranscript, done: boolean): Promise<void> {
    await this.prisma.strategyIntakeSession.update({
      where: { id: sessionId },
      data: { transcript: transcript as any, status: done ? 'COMPLETE' : 'IN_PROGRESS' },
    });
  }

  /** One interview turn: a single Anthropic call. Interprets the first tool_use —
   *  `intake_done` ends the interview; `ask_questions` returns the next batch. */
  private async interviewTurn(
    messages: Anthropic.MessageParam[],
    deltas: string[],
  ): Promise<{ toolUse: Anthropic.ToolUseBlock | null; questions: string[]; done: boolean }> {
    const system = deltas.length
      ? `${this.INTERVIEW_SYSTEM}\nArchetype-suggested angles to probe: ${deltas.join(' | ')}`
      : this.INTERVIEW_SYSTEM;
    const res = await this.anthropic.complete({
      system,
      messages,
      tools: INTAKE_TOOLS,
      maxTokens: 1024,
      tier: tierFor('strategy.interview'),
    });
    const tu = res.toolUses[0] ?? null;
    if (!tu || tu.name === 'intake_done') return { toolUse: tu, questions: [], done: true };
    const questions = strArr((tu.input as { questions?: unknown })?.questions).slice(0, MAX_QUESTIONS);
    return { toolUse: tu, questions, done: false };
  }

  /** Kick off the Brand Brain build from the intake's own inputs. Best-effort
   *  and skipped when a brand profile already exists — apply() upserts the
   *  profile as OWNED, and auto-overwriting a brand the user has already
   *  shaped is exactly the kind of surprise onboarding must not produce. */
  private async startBrandBrain(workspaceId: string, input: StrategyIntakeInput): Promise<void> {
    if (!input.url) return;
    try {
      const existing = await this.prisma.brandProfile.findUnique({
        where: { workspaceId },
        select: { id: true },
      });
      if (existing) return;
      await this.brandAnalysis.startAnalysis(workspaceId, {
        websiteUrl: input.url,
        socialHandles: input.socials,
        autoApply: true,
      });
    } catch (e) {
      // Onboarding must never fail because a background enrichment could not
      // start — the strategy interview is the critical path here.
      this.logger.warn(
        `strategy-intake: brand-brain kickoff failed for ws ${workspaceId}: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  /** Record what the source adapters actually spent, mirroring
   *  brand-analysis.service.ts. Best-effort: an accounting miss must never
   *  break onboarding, which is the one flow a new customer cannot route
   *  around. */
  private async settleSourceSpend(
    workspaceId: string,
    material: BrandSourceResult[],
  ): Promise<void> {
    for (const r of material) {
      try {
        if (r.firecrawlPages) {
          await this.spend.settle(workspaceId, {
            unit: 'FIRECRAWL_PAGE',
            quantity: r.firecrawlPages,
            ref: `strategy-intake:${workspaceId}`,
          });
        }
        if (r.apifyRuns) {
          await this.spend.settle(workspaceId, {
            unit: 'APIFY_RUN',
            quantity: r.apifyRuns,
            ref: `strategy-intake:${workspaceId}`,
          });
        }
      } catch (e) {
        this.logger.warn(
          `strategy-intake: source spend accounting failed for ws ${workspaceId}: ${(e as Error)?.message ?? e}`,
        );
      }
    }
  }

  /** Reuse the Brand Brain website/social source adapters to gather the
   *  workspace's own material, then one Anthropic call to extract product /
   *  category / tone / suggested archetype. Never throws on a source miss — the
   *  adapters return `inert`/`error` and the model reasons from the one-liner. */
  private async autoAnalyze(workspaceId: string, input: StrategyIntakeInput): Promise<StrategyAutoAnalysis> {
    const brandInput: BrandSourceInput = {
      websiteUrl: input.url,
      socialHandles: input.socials,
    };
    const material: BrandSourceResult[] = [];
    material.push(await this.website.collect(workspaceId, brandInput));
    if (brandInput.socialHandles?.length) material.push(await this.social.collect(workspaceId, brandInput));

    // These adapters spend real Firecrawl/Apify money on Jeeta's accounts, and
    // this path recorded none of it — brand-analysis.service.ts settles the
    // very same counters (:87,:91) while onboarding, which crawls the same way
    // for every new workspace, did not import the ledger at all. Accounting
    // only: ResearchSpendService never blocks and never throws, and it no-ops
    // without a ChannelTariff row, so this cannot fail an onboarding.
    await this.settleSourceSpend(workspaceId, material);

    const res = await this.anthropic.complete({
      system:
        'You classify a business from its own website + social material for a marketing-strategy onboarding. ' +
        'Extract what it sells (product), its category, its brand tone, and the single best-fit archetype key. ' +
        'Submit via submit_analysis. If material is thin, infer conservatively from the one-liner.',
      messages: [{ role: 'user', content: this.buildAnalysisPrompt(input, material) }],
      tools: ANALYSIS_TOOL,
      maxTokens: 1024,
      tier: tierFor('strategy.interview'),
    });
    const tu = res.toolUses.find((t) => t.name === 'submit_analysis');
    const a = (tu?.input ?? {}) as Record<string, unknown>;
    return {
      product: str(a.product),
      category: str(a.category),
      tone: str(a.tone),
      suggestedArchetype: validArchetype(a.suggestedArchetype),
      sources: material.map((m) => ({ source: m.source, status: m.status })),
    };
  }

  private buildAnalysisPrompt(input: StrategyIntakeInput, material: BrandSourceResult[]): string {
    return [
      input.oneLiner ? `ONE-LINER: ${input.oneLiner}` : '',
      input.url ? `WEBSITE: ${input.url}` : '',
      input.socials?.length ? `SOCIALS: ${input.socials.map((s) => `${s.network}:${s.handle}`).join(', ')}` : '',
      `SOURCE MATERIAL: ${JSON.stringify(material).slice(0, 8000)}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildKickoff(input: StrategyIntakeInput, auto: StrategyAutoAnalysis): string {
    return [
      'Begin the onboarding interview.',
      input.oneLiner ? `Operator one-liner: ${input.oneLiner}` : '',
      `AUTO-ANALYSIS: ${JSON.stringify(auto)}`,
      'Ask ONLY the gaps this analysis leaves + the strategic intent. Emit them via ask_questions.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private readonly INTERVIEW_SYSTEM =
    'You are an onboarding strategist for a marketing-automation platform. ' +
    'Given the auto-analysis, ask ONLY the gaps it leaves + the strategic intent (goal, audience specifics, budget, competitors, constraints, offer). ' +
    // What has ALREADY been tried is the highest-signal input a strategist can
    // get: it tells the synthesis which channels are proven, which failed and
    // why, and where the customer's instincts point. The auto-analysis cannot
    // see any of it, so this is a REQUIRED topic, not a gap-filler.
    'You MUST ask, in some form: how do they currently acquire customers (or plan to), which acquisition methods they have already tried, and what results those produced. ' +
    'Keep questions short and concrete. Adapt to the suggested archetype signals. ' +
    'Emit questions via ask_questions; when you have enough to synthesize a strategy, call intake_done.';
}

function str(v: unknown): string | null {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
}

function validArchetype(v: unknown): BusinessArchetype | null {
  return typeof v === 'string' && v in ARCHETYPES ? (v as BusinessArchetype) : null;
}
