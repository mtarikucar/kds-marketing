import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { ResearchRunnerService } from '../../research/research-runner.service';
import { MarketingResearchService } from '../../services/marketing-research.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ResearchToolDeps {
  research: MarketingResearchService;
  /** The "Run now" enqueue path — see `jeeta.run_research` for why the runner
   *  and not `ResearchWorkerService.runProfile` directly. */
  runner: ResearchRunnerService;
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
 * Accepting candidates is deliberately not exposed as a tool in this wave: it
 * is the human review step the whole staging queue exists for, and it is the
 * step that consumes quota.
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
}
