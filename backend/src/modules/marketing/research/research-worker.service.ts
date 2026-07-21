import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost, tierFor } from '../ai/ai-credit-costs';
import { AgentRunService } from '../agents/agent-run.service';
import { ResearchSourcesService } from './providers/research-sources.service';
import { ResearchSpendService } from '../budget/research-spend.service';
import { RESEARCH_TOOLS, dispatchResearchTool, ResearchToolCtx } from './research-toolset';
import { ResearchCandidateService, StagedCandidate } from './research-candidate.service';
import { ResearchJob } from './research-job.service';
import { EXTERNAL_REF_PATTERN } from '../dto/ingest-leads.dto';
import { BrandContextService } from '../brand-brain/brand-context.service';

export interface ResearchRunResult {
  runId: string | null;
  researched: number;
  staged: number;
  duplicates: number;
  skipped?: string;
}

const MAX_ITERS = 8;
const MAX_TOOL_CALLS = 30;
const MAX_WALL_MS = Number(process.env.RESEARCH_RUN_MAX_MS ?? 120_000);
const STAGES = new Set(['GROWING', 'STRUGGLING', 'STABLE']);
const PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

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
        await this.credits.reserve(job.workspaceId, creditCost('research.qualify'));
        try {
          const geo = (job.profile.geo as ResearchToolCtx['geo']) ?? {};
          const ctx: ResearchToolCtx = { workspaceId: job.workspaceId, runId, geo, budgetId: null };
          const deps = { sources: this.sources, spend: this.spend, runs: this.runs };

          const brand = await this.brandContext.summaryFor(job.workspaceId);
          const messages: Anthropic.MessageParam[] = [{ role: 'user', content: this.buildBrief(job, brand) }];
          let candidates: StagedCandidate[] = [];
          let toolCalls = 0;
          const deadline = Date.now() + MAX_WALL_MS;

          for (let i = 0; i < MAX_ITERS && Date.now() < deadline && toolCalls < MAX_TOOL_CALLS; i++) {
            const res = await this.anthropic.complete({
              system: this.SYSTEM,
              messages,
              tools: RESEARCH_TOOLS,
              maxTokens: 4000,
              tier: tierFor('research.qualify'),
              cacheSystem: true,
            });
            if (!res.toolUses.length) break;

            const results: Anthropic.ToolResultBlockParam[] = [];
            let submitted = false;
            for (const tu of res.toolUses) {
              if (tu.name === 'submit_candidates') {
                candidates = this.validate((tu.input as { candidates?: unknown[] })?.candidates ?? []);
                results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ received: candidates.length }) });
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

          // Bound volume relative to what can actually be accepted (cost guard).
          const cap = job.remainingToday === -1 ? job.maxBatchSize : Math.min(job.remainingToday + 10, job.maxBatchSize);
          candidates = candidates.slice(0, cap);

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
          await this.credits.refund(job.workspaceId, creditCost('research.qualify')).catch(() => undefined);
          throw e;
        }
      },
    );
  }

  /** Keep only well-formed candidates (the ingest DTO re-validates on accept). */
  private validate(raw: unknown[]): StagedCandidate[] {
    const out: StagedCandidate[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const c = r as Record<string, unknown>;
      const externalRef = String(c.externalRef ?? '').trim();
      const businessName = String(c.businessName ?? '').trim();
      const businessType = String(c.businessType ?? 'OTHER').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_') || 'OTHER';
      const painPoint = String(c.painPoint ?? '').trim();
      const evidence = String(c.evidence ?? '').trim();
      const pitch = String(c.pitch ?? '').trim();
      if (!EXTERNAL_REF_PATTERN.test(externalRef) || !businessName || !painPoint || !evidence || !pitch) continue;
      const stage = typeof c.stage === 'string' && STAGES.has(c.stage) ? c.stage : undefined;
      const priority = typeof c.priority === 'string' && PRIORITIES.has(c.priority) ? c.priority : 'MEDIUM';
      out.push({
        externalRef, businessName, businessType, painPoint: painPoint.slice(0, 1000),
        evidence: evidence.slice(0, 500), pitch: pitch.slice(0, 500),
        city: str(c.city), region: str(c.region), phone: str(c.phone), instagram: str(c.instagram),
        website: str(c.website), email: str(c.email), currentSystem: str(c.currentSystem),
        branchCount: Number.isFinite(Number(c.branchCount)) ? Number(c.branchCount) : undefined,
        stage, priority, score: Number.isFinite(Number(c.score)) ? Number(c.score) : undefined,
      });
    }
    return out;
  }

  private readonly SYSTEM =
    'You are a B2B prospect-research agent inside a multi-tenant lead-generation platform. ' +
    'Research the given ICP with the tools and return ONLY qualified, evidence-backed lead candidates. ' +
    'Qualify on EVIDENCE (concrete pain in recent negative reviews, growth/hiring signals, operational gaps the product solves) — never on vibes. ' +
    'HARD DISQUALIFIERS: business closed/inactive; clearly outside the ICP size; no reachable contact (need phone, instagram, email or website); no verifiable evidence; anything matching the profile exclusions or outside its geo/businessTypes. ' +
    'externalRef is the cross-day dedup key — use the first applicable of phone:+<E164>, instagram:@handle, google:<placeId>, domain:<apex>, hash:<sha1(lowercase(businessName|city))>; never randomize it. ' +
    'Write painPoint/evidence/pitch in the profile language. Padding weak leads is worse than returning few. ' +
    'When done, call submit_candidates exactly once with your final list.';

  private buildBrief(job: ResearchJob, brand: string | null): string {
    const p = job.profile;
    const geo = p.geo as { country?: string; regions?: string[]; cities?: string[] } | null;
    const bt = Array.isArray(p.businessTypes) ? (p.businessTypes as string[]).join(', ') : '';
    return [
      `PRODUCT: ${job.productName ?? ''}${job.productUrl ? ` (${job.productUrl})` : ''}`,
      brand ? `BRAND CONTEXT: ${brand}` : '',
      job.productDescription ? `WHAT IT DOES: ${job.productDescription}` : '',
      `ICP (who to find + what pain): ${p.icpDescription}`,
      p.productPitch ? `PITCH ANGLE: ${p.productPitch}` : '',
      geo ? `GEO (hard filter): ${JSON.stringify(geo)}` : '',
      bt ? `BUSINESS TYPES (hard filter): ${bt}` : '',
      p.exclusions ? `EXCLUSIONS (hard filter): ${p.exclusions}` : '',
      `LANGUAGE for painPoint/evidence/pitch: ${p.language}`,
      `TARGET VOLUME: up to ${job.remainingToday === -1 ? job.maxBatchSize : Math.min(job.remainingToday, 20)} strong candidates. Fewer is fine.`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}

function str(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s ? s : undefined;
}
