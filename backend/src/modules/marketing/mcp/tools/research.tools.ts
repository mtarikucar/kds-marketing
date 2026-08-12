import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { ResearchCandidateService } from '../../research/research-candidate.service';
import { ResearchRunnerService } from '../../research/research-runner.service';
import { MarketingResearchService } from '../../services/marketing-research.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ResearchToolDeps {
  research: MarketingResearchService;
  /** The "Run now" enqueue path — see `jeeta.run_research` for why the runner
   *  and not `ResearchWorkerService.runProfile` directly. */
  runner: ResearchRunnerService;
  /** The staging queue every run writes into — read, accept, reject. */
  candidates: ResearchCandidateService;
  entitlements: EntitlementsService;
}

const LANGUAGES = ['en', 'tr', 'ru', 'uz', 'ar'] as const;

/**
 * Faz 5 D4 — prospect research.
 *
 * ## The daily lead quota is INHERITED, not re-implemented
 *
 * This is the sharpest safety question in the wave: a tool that mints leads in
 * bulk without touching `MarketingLeadsIngestService.reserveQuota` would be a
 * real quota bypass — the workspace's paid daily allowance simply would not
 * apply to anything an agent asked for. It does not happen here, and the reason
 * is worth stating precisely, because it is a property of the pipeline rather
 * than of this file:
 *
 *  1. `jeeta.run_research` calls `ResearchRunnerService.enqueueNow`, which
 *     schedules a `research.run` job (deduped per profile).
 *  2. The job handler calls `ResearchJobService.buildJob`, which reads
 *     `MarketingLeadsIngestService.usageToday(workspaceId)` and returns `null`
 *     — no run at all — when the daily allowance is exhausted, and otherwise
 *     carries `remainingToday` into the job.
 *  3. `ResearchWorkerService.runProfile` caps the batch it will keep against
 *     that `remainingToday`, then STAGES the survivors as `ResearchCandidate`
 *     rows. It creates no `Lead` and consumes no quota.
 *  4. A lead row only exists once a human accepts a staged candidate, and that
 *     path is `ResearchCandidateService.accept` →
 *     `MarketingLeadsIngestService.ingest` → `reserveQuota` (advisory-locked
 *     `UsageCounter` against `LeadQuotaResolver.getDailyLeadQuota`), which
 *     clips beyond the grant.
 *
 * So research SPENDS (AI credits + firecrawl/apify money) but does not MINT.
 * Accepting is where quota is consumed and a lead first exists.
 *
 * ## Why the review queue IS exposed (revised)
 * An earlier wave left the candidate queue off MCP entirely, reasoning that
 * accepting is "the human review step the staging queue exists for". Running
 * the pipeline end to end against a real workspace showed what that produced:
 * research ran, staged its finds, and the agent driving that workspace could
 * START a run costing real credits and crawl money yet could not READ one thing
 * it paid for. Three qualified prospects sat PENDING while the same three
 * businesses were re-entered by hand. Spending money and being structurally
 * blind to the result is not a safety property.
 *
 * So the gate moved rather than disappeared. `list_research_candidates` is READ
 * — seeing what you already bought needs no permission. `accept` and `reject`
 * carry `requiresApproval`, so an APPROVAL-mode workspace still gets its human
 * review step, and an AUTONOMOUS one (an owner's deliberate, revocable setting)
 * lets its agent close the loop. Accept still routes through
 * `ResearchCandidateService.accept` → `ingest` → `reserveQuota`, so the daily
 * lead allowance clips an agent exactly as it clips the panel.
 *
 * ## Why the runner, not the worker
 * `ResearchWorkerService.runProfile` takes a fully-built `ResearchJob` and runs
 * for up to two minutes in-process. Building that job here would mean
 * re-deriving `remainingToday` — i.e. re-implementing exactly the quota read
 * this file must not own. `enqueueNow` is the same entry point the panel's "Run
 * now" button uses, and it keeps the quota check where it belongs.
 *
 * ## Module gate
 * Unlike the workflow lane there is no `@RequiresFeature` on the REST research
 * controller, so gating on `research` makes MCP STRICTER than REST. That is
 * deliberate: `research` is a Settings > Modules toggle that new workspaces
 * start with switched OFF, and "the workspace switched this module off" is a
 * clear statement that it does not want an agent spending money on prospecting.
 * The refusal names the feature, so an agent can tell the user exactly which
 * toggle to flip.
 */
export function registerResearchTools(registry: McpToolRegistry, deps: ResearchToolDeps): void {
  registry.register({
    name: 'jeeta.list_research_profiles',
    description:
      "List the prospect-research briefs this workspace hunts against (who to look for, where, and how to pitch them), with each brief's last run and results. Also returns today's remaining lead allowance, which is the ceiling on how many researched prospects can become leads today. Read-only.",
    domain: 'research',
    scopes: ['settings.manage'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'research');
      const [profiles, dailyLeadQuota] = await Promise.all([
        deps.research.list(ctx.workspaceId),
        deps.research.usage(ctx.workspaceId),
      ]);
      // The quota rides along on the primary read so a model planning a hunt
      // sees the ceiling BEFORE asking for a run it cannot use the output of.
      return { profiles, dailyLeadQuota };
    },
  });

  registry.register({
    name: 'jeeta.create_research_profile',
    description:
      'Create a prospect-research brief: describe who to find (the ideal customer, the pain signals to look for), optionally where geographically, in which language, and how to pitch them. Creating a brief costs nothing on its own; the nightly research agent will pick it up, and every prospect it finds is staged for human review before becoming a lead. The number of briefs is capped by the workspace plan.',
    domain: 'research',
    // Deferred (spec §3): a one-off setup call, not per-turn work.
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(120).describe('Short label for this brief, for the panel.'),
      icpDescription: z
        .string()
        // Same floor the REST DTO enforces (@MinLength(40)): a one-word brief
        // produces a run that spends money and finds nothing usable.
        .min(40)
        .max(4000)
        .describe(
          'Who to find and which pain signals to hunt for. Be specific — this is the researcher\'s whole instruction, and it must be at least 40 characters.',
        ),
      productPitch: z.string().max(1000).optional().describe('How to pitch our product to this audience.'),
      geo: z
        .object({
          country: z.string().max(80).optional(),
          regions: z.array(z.string().max(80)).max(30).optional(),
          cities: z.array(z.string().max(80)).max(30).optional(),
        })
        .optional()
        .describe('Where to look. Regions and cities are lists, never a single string.'),
      language: z.enum(LANGUAGES).optional().describe('Language of the sources to research (default en).'),
      businessTypes: z.array(z.string().max(80)).max(20).optional().describe('Restrict to these business types.'),
      exclusions: z.string().max(1000).optional().describe('Who NOT to include.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'research');
      return deps.research.create(ctx.workspaceId, {
        name: String(args.name ?? ''),
        icpDescription: String(args.icpDescription ?? ''),
        ...(args.productPitch !== undefined ? { productPitch: String(args.productPitch) } : {}),
        ...(args.geo !== undefined ? { geo: args.geo as never } : {}),
        ...(args.language !== undefined ? { language: String(args.language) } : {}),
        ...(args.businessTypes !== undefined ? { businessTypes: args.businessTypes as string[] } : {}),
        ...(args.exclusions !== undefined ? { exclusions: String(args.exclusions) } : {}),
      } as never);
    },
  });

  registry.register({
    name: 'jeeta.run_research',
    description:
      "Run a prospect-research brief right now instead of waiting for tonight. The research agent searches the live web, which SPENDS this workspace's AI credits and real scraping money — in APPROVAL mode this queues for a human; in AUTONOMOUS mode it runs immediately. The run is queued and takes a few minutes; the prospects it finds are staged in the review queue and only become leads once someone accepts them, against the daily lead allowance. Nothing happens if the brief is paused or the allowance is already exhausted.",
    domain: 'research',
    // Deferred (spec §3): expensive and occasional.
    defer: true,
    scopes: ['settings.manage'],
    risk: 'SPEND',
    requiresApproval: true,
    approvalKind: 'AI_SPEND',
    resourceType: 'research_profile',
    resourceIdFrom: (args) => (typeof args.profileId === 'string' ? args.profileId : undefined),
    inputSchema: z.object({
      profileId: z.string().min(1).describe('Id of the brief to run, from jeeta.list_research_profiles.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'research');
      const profileId = String(args.profileId ?? '');
      await deps.runner.enqueueNow(ctx.workspaceId, profileId);
      // `enqueueNow` resolves void. Say what actually happened rather than
      // returning nothing, and be explicit that the quota/paused checks happen
      // when the job runs, not now.
      return {
        enqueued: true,
        profileId,
        message:
          'Research run queued. It runs in the background and is skipped silently if the brief is paused or the daily lead allowance is already used up. Results appear in the research review queue.',
      };
    },
  });

  registry.register({
    name: 'jeeta.list_research_candidates',
    description:
      'List prospects the research agent found and staged for review — business name, contact details, the pain signal it spotted, the evidence behind it and a 0-1 score. These are NOT leads yet: nothing can be called, emailed or assigned until they are accepted. Read this after a run to see what the workspace paid for, then accept the good ones with jeeta.accept_research_candidates. Read-only.',
    domain: 'research',
    // Deferred (spec §3): read between runs, not per-turn.
    defer: true,
    scopes: ['settings.manage'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      status: z
        .enum(['PENDING', 'ACCEPTED', 'REJECTED'])
        .optional()
        .describe('Which slice of the queue (default PENDING — the ones still awaiting a decision).'),
      profileId: z
        .string()
        .min(1)
        .optional()
        .describe('Only candidates from this brief, from jeeta.list_research_profiles.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'research');
      const rows = await deps.candidates.list(ctx.workspaceId, {
        ...(args.status !== undefined ? { status: String(args.status) } : {}),
        ...(args.profileId !== undefined ? { profileId: String(args.profileId) } : {}),
      });
      // Carry the allowance alongside: accepting is quota-clipped, so a model
      // deciding WHICH candidates to accept needs to know how many it can.
      const dailyLeadQuota = await deps.research.usage(ctx.workspaceId);
      return { candidates: rows, dailyLeadQuota };
    },
  });

  registry.register({
    name: 'jeeta.accept_research_candidates',
    description:
      "Accept staged prospects and turn them into real leads in the CRM. This is the step that consumes the workspace's daily lead allowance, and once accepted a prospect becomes a contactable lead that automations and agents can act on. Accepts only the ids you pass — review the evidence with jeeta.list_research_candidates first rather than accepting the whole queue blindly. Candidates beyond today's allowance stay PENDING and can be accepted tomorrow.",
    domain: 'research',
    defer: true,
    scopes: ['leads.write'],
    risk: 'WRITE',
    // The human review step this queue exists for. AUTONOMOUS workspaces bypass
    // it via the broker — that is the owner's setting, not this tool's call.
    requiresApproval: true,
    inputSchema: z.object({
      candidateIds: z
        .array(z.string().min(1))
        .min(1)
        .max(200)
        .describe('Ids of the candidates to accept, from jeeta.list_research_candidates.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'research');
      const ids = (args.candidateIds ?? []) as string[];
      const res = await deps.candidates.accept(ctx.workspaceId, ids);
      // `accepted` can be lower than the ids passed — the quota clips, and a
      // clipped candidate deliberately stays PENDING. Say so, rather than
      // reporting a bare count a caller would read as full success.
      const clipped = ids.length - res.accepted;
      return {
        ...res,
        requested: ids.length,
        message:
          clipped > 0
            ? `${res.accepted} of ${ids.length} became leads. The other ${clipped} were not accepted — usually today's lead allowance running out — and remain PENDING for a later run.`
            : `${res.accepted} candidate(s) are now leads.`,
      };
    },
  });

  registry.register({
    name: 'jeeta.reject_research_candidates',
    description:
      'Dismiss staged prospects that are not a fit, removing them from the review queue without creating leads. Consumes no lead allowance. Use this to keep the queue meaningful — without it every poor match found by every nightly run accumulates forever and buries the good ones.',
    domain: 'research',
    defer: true,
    scopes: ['leads.write'],
    risk: 'WRITE',
    // Dismissing a prospect the owner never saw is a judgement call, so it sits
    // behind the same gate as accepting. The row is retained as REJECTED and
    // stays readable, so this is reversible in the panel.
    requiresApproval: true,
    inputSchema: z.object({
      candidateIds: z
        .array(z.string().min(1))
        .min(1)
        .max(200)
        .describe('Ids of the candidates to dismiss, from jeeta.list_research_candidates.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'research');
      const ids = (args.candidateIds ?? []) as string[];
      const res = await deps.candidates.reject(ctx.workspaceId, ids);
      return { ...res, requested: ids.length };
    },
  });
}
