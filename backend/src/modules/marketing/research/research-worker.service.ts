import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost, tierFor } from '../ai/ai-credit-costs';
import { AgentRunService } from '../agents/agent-run.service';
import { ResearchSourcesService } from './providers/research-sources.service';
import { ResearchSpendService } from '../budget/research-spend.service';
import { RESEARCH_TOOLS, SUBMIT_CANDIDATES_TOOL, dispatchResearchTool, ResearchToolCtx } from './research-toolset';
import { ResearchCandidateService, StagedCandidate } from './research-candidate.service';
import { ResearchJob } from './research-job.service';
import {
  RESEARCH_SYSTEM_PROMPT,
  buildResearchBrief,
  researchBatchCap,
  validateResearchCandidates,
} from './research-contract';
import { BrandContextService } from '../brand-brain/brand-context.service';

export interface ResearchRunResult {
  runId: string | null;
  researched: number;
  staged: number;
  duplicates: number;
  skipped?: string;
}

const MAX_ITERS = 8;
// Grace window for the mandatory final submit() turn — the deadline bounds the
// research loop, but the forced conversion of already-gathered prospects into
// candidates is worth one call just past it.
const FORCE_SUBMIT_GRACE_MS = 30_000;
const MAX_TOOL_CALLS = 30;
const MAX_WALL_MS = Number(process.env.RESEARCH_RUN_MAX_MS ?? 120_000);

/**
 * The native prospect-research agent — a bounded Claude tool-loop that replaces
 * the external nightly routine. Per profile it researches the live web via the
 * platform-keyed source providers (firecrawl/apify) and finalizes qualified
 * candidates into the review queue. Every run is one AgentRun (each source call
 * a ToolCallLog); firecrawl/apify/LLM cost meters into the workspace budget.
 * MONEY/COST SAFETY: inert when sources unconfigured; hard caps on iterations,
 * tool calls, wall-clock and a reserved credit ceiling bound each run's spend.
 */
@Injectable()
export class ResearchWorkerService {
  private readonly logger = new Logger(ResearchWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
    private readonly runs: AgentRunService,
    private readonly sources: ResearchSourcesService,
    private readonly spend: ResearchSpendService,
    private readonly candidates: ResearchCandidateService,
    private readonly brandContext: BrandContextService,
  ) {}

  async runProfile(job: ResearchJob): Promise<ResearchRunResult> {
    if (!this.sources.isEnabled()) {
      return { runId: null, researched: 0, staged: 0, duplicates: 0, skipped: 'sources-not-configured' };
    }
    if (!this.anthropic.isEnabled()) {
      return { runId: null, researched: 0, staged: 0, duplicates: 0, skipped: 'ai-not-configured' };
    }

    return this.runs.track(
      job.workspaceId,
      { agent: 'research', goal: `Prospect for "${job.profile.name}"`, input: { profileId: job.profile.id, geo: job.profile.geo } },
      async (runId) => {
        // Base only. The tool-loop below is charged PER TURN: one flat
        // per-run reserve priced a single credit amount for anywhere between
        // one and MAX_ITERS Opus calls at maxTokens 4000, so a long run cost
        // Jeeta roughly thirty times what it charged.
        await this.credits.reserve(job.workspaceId, creditCost('research.qualify'));
        let turnsCharged = 0;
        let turnsCompleted = 0;
        try {
          const geo = (job.profile.geo as ResearchToolCtx['geo']) ?? {};
          const ctx: ResearchToolCtx = { workspaceId: job.workspaceId, runId, geo, budgetId: null };
          const deps = { sources: this.sources, spend: this.spend, runs: this.runs };

          const brand = await this.brandContext.summaryFor(job.workspaceId);
          const messages: Anthropic.MessageParam[] = [{ role: 'user', content: buildResearchBrief(job, brand) }];
          let candidates: StagedCandidate[] = [];
          let everSubmitted = false;
          let toolCalls = 0;
          const deadline = Date.now() + MAX_WALL_MS;

          for (let i = 0; i < MAX_ITERS && Date.now() < deadline && toolCalls < MAX_TOOL_CALLS; i++) {
            // Charge before the call: an exhausted workspace must stop
            // spending, not find out afterwards. This runs unattended from the
            // nightly research cron, which is exactly where an unmetered loop
            // does the most damage.
            await this.credits.reserve(job.workspaceId, creditCost('research.turn'));
            turnsCharged += 1;
            const res = await this.anthropic.complete({
              system: RESEARCH_SYSTEM_PROMPT,
              messages,
              tools: RESEARCH_TOOLS,
              cacheTools: true,
              // The transcript, not the header, is what this loop re-sends:
              // every prior tool result (8.000 chars each) rides along on
              // every turn.
              cacheConversation: true,
              maxTokens: 4000,
              tier: tierFor('research.turn'), workspaceId: job.workspaceId, action: 'research.turn',
              cacheSystem: true,
            });
            turnsCompleted += 1;
            if (!res.toolUses.length) break;

            const results: Anthropic.ToolResultBlockParam[] = [];
            let submitted = false;
            for (const tu of res.toolUses) {
              if (tu.name === 'submit_candidates') {
                candidates = validateResearchCandidates((tu.input as { candidates?: unknown[] })?.candidates ?? []);
                results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ received: candidates.length }) });
                submitted = true;
                everSubmitted = true;
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

          // Forced final submit: the loop can exhaust MAX_ITERS / MAX_TOOL_CALLS
          // / the deadline while the model is still searching+scraping, and
          // never call submit_candidates — so all the prospects it gathered are
          // silently dropped and the run logs "0 qualified" (observed live: 7
          // searches + 10 scrapes, 0 submits). One more turn, tool_choice
          // forcing submit_candidates with NO research tools offered, converts
          // the research already in context into candidates instead of wasting
          // it. Only when nothing was submitted and we actually did some
          // research; still credit-reserved and refunded like any turn.
          // Only when the model NEVER submitted — an explicit empty submit means
          // "genuinely none qualify" and must be respected, not overridden.
          if (!everSubmitted && toolCalls > 0 && Date.now() < deadline + FORCE_SUBMIT_GRACE_MS) {
            try {
              await this.credits.reserve(job.workspaceId, creditCost('research.turn'));
              turnsCharged += 1;
              messages.push({
                role: 'user',
                content:
                  'You are out of research budget. Call submit_candidates NOW with every prospect you have ' +
                  'already gathered that meets the bar (reachable contact + concrete evidence). Return an empty ' +
                  'list only if genuinely none qualify — but do not discard qualified prospects just because you ran out of turns.',
              });
              const forced = await this.anthropic.complete({
                system: RESEARCH_SYSTEM_PROMPT,
                messages,
                tools: [SUBMIT_CANDIDATES_TOOL],
                toolChoice: { type: 'tool', name: 'submit_candidates' },
                maxTokens: 4000,
                tier: tierFor('research.turn'),
                workspaceId: job.workspaceId,
                action: 'research.turn',
                cacheSystem: true,
              });
              turnsCompleted += 1;
              const submitTu = forced.toolUses.find((t) => t.name === 'submit_candidates');
              if (submitTu) {
                candidates = validateResearchCandidates((submitTu.input as { candidates?: unknown[] })?.candidates ?? []);
                this.logger.log(`research run ${runId}: forced submit recovered ${candidates.length} candidate(s) (ws ${job.workspaceId})`);
              }
            } catch (e) {
              this.logger.warn(`research run ${runId}: forced submit failed (ws ${job.workspaceId}): ${(e as Error)?.message ?? e}`);
            }
          }

          // Bound volume relative to what can actually be accepted (cost guard).
          candidates = candidates.slice(0, researchBatchCap(job));

          const { staged, duplicates } = await this.candidates.stage(job.workspaceId, job.profile.id, runId, candidates);
          if (staged > 0) {
            await this.spend.settle(job.workspaceId, { unit: 'RESEARCH_LEAD', quantity: staged, ref: runId });
          }
          await this.prisma.researchProfile
            .updateMany({
              where: { id: job.profile.id, workspaceId: job.workspaceId },
              data: { lastRunAt: new Date(), lastRunStats: { posted: candidates.length, staged, duplicates, at: new Date().toISOString() } },
            })
            .catch(() => undefined);

          this.logger.log(`research run ${runId}: ${candidates.length} qualified, ${staged} staged, ${duplicates} dupes (ws ${job.workspaceId})`);
          return { runId, researched: candidates.length, staged, duplicates };
        } catch (e) {
          // Refund the base and only the turn that did NOT run.
          // Turns whose Anthropic call actually RETURNED are real vendor spend
          // and must stay charged. Refunding them let a workspace sitting just
          // under its cap replay the loop for free: charge a turn, execute it,
          // hit AI_CREDITS_EXHAUSTED on the next one, get everything back.

          await this.credits
            .refund(
              job.workspaceId,
              creditCost('research.qualify') +
                Math.max(0, turnsCharged - turnsCompleted) * creditCost('research.turn'),
            )
            .catch(() => undefined);
          throw e;
        }
      },
    );
  }
}
