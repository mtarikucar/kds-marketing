import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { AgentRunService } from '../../agents/agent-run.service';
import { ResearchSpendService } from '../../budget/research-spend.service';
import { ResearchCandidateService } from '../../research/research-candidate.service';
import { ResearchLeaseService } from '../../research/research-lease.service';
import { ResearchRunnerService } from '../../research/research-runner.service';
import { ResearchSourcesService } from '../../research/providers/research-sources.service';
import { dispatchResearchTool } from '../../research/research-toolset';
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
  /** The MCP lane: lease a queued job, submit against it, close it. */
  lease: ResearchLeaseService;
  /** Apify/Firecrawl/native — Jeeta's own vendor keys, reused not reimplemented. */
  sources: ResearchSourcesService;
  /** Meters the vendor calls into the workspace's research budget. */
  spend: ResearchSpendService;
  /** ToolCallLog for every vendor call, against the leased job's AgentRun. */
  runs: AgentRunService;
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
    name: 'jeeta.pause_research_profile',
    description:
      'Stop a research brief from running. A brief is picked up by the nightly agent every night for as long as it is active, and each run spends real money on crawling and models — so an experiment left switched on keeps billing forever. Pausing takes it out of the nightly fan-out and changes nothing else; the brief, its history and its staged candidates are kept. Re-activating is a panel action.',
    domain: 'research',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    // Ungated: this only ever REDUCES spend. The verb that needs a human is
    // switching a brief on, which is why re-activation stays in the panel —
    // an agent may narrow its own reach, never widen it.
    requiresApproval: false,
    inputSchema: z.object({
      profileId: z.string().min(1).describe('Id of the research brief to pause.'),
    }),
    handler: async (ctx, args) =>
      deps.research.update(ctx.workspaceId, String(args.profileId), {
        status: 'PAUSED',
      } as never),
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

  registerResearchMcpLane(registry, deps);
}

/**
 * The MCP research lane (spec: 2026-08-31 "Gece araştırmasını MCP'ye taşımak").
 *
 * ## What moved, and why
 *
 * Live measurement put the nightly research agent at 86% of the platform's
 * whole Anthropic bill — $7.80/month on ONE workspace, growing linearly with
 * customers because the platform runs a single shared API key. The `@Cron` that
 * BUILDS those jobs spends nothing; the money is spent by whoever drains the
 * queue. So the drainer moves, and only the drainer.
 *
 * A workspace on `researchExecution: 'MCP'` has its research jobs left in the
 * queue by the server runner. Its own Claude leases one with
 * `claim_research_job`, does the reasoning and the general web search on its own
 * subscription, hands the results back with `submit_research_candidates`, and
 * closes the job with `complete_research_job`.
 *
 * ## Why the instruction comes from here and not from the caller
 *
 * `claim_research_job` returns the FULL brief — ICP, geo, business types,
 * exclusions, language, the hard disqualifiers, the externalRef dedup
 * convention and the output contract — assembled by `research-contract.ts`,
 * the same module the in-process worker reads. Quality must not be a function
 * of the sentence an owner typed into a scheduled task months ago, and the two
 * lanes must not drift apart into "the MCP mode finds worse leads".
 *
 * ## Why three data tools stay on Jeeta's keys
 *
 * `search_places` and `lookup_instagram` go to Apify; `scrape_page` goes to
 * Firecrawl first. Those are Jeeta's vendor accounts, and the bill stays with
 * Jeeta whoever calls them — they are not part of the $9.11 this design moves.
 * They are exposed anyway because Google Maps listings and their recent reviews
 * are the PRIMARY source of the pain signal every candidate is qualified on,
 * and Claude's general web search cannot substitute for them.
 *
 * `search_web` is deliberately NOT exposed. The owner's Claude does its own
 * searching — that is where `research.native_search` ($1.37/month) disappears
 * to, and re-exposing it would hand the saving straight back.
 *
 * ## Risk and gating
 *
 * Classified honestly, then gated by the catalogue's existing rules rather than
 * by what would be convenient for this lane:
 *
 *  - The three vendor tools are SPEND + `AI_SPEND`, like every other SPEND in
 *    this catalogue. Calling them WRITE to make the lane work unattended would
 *    be a lie about where the money goes.
 *
 *    What that gate costs is worth stating exactly, because it is NOT a delay.
 *    `McpApprovalExecutorService.apply()` returns the tool result to the
 *    approving human's HTTP response — it does not resume the agent's turn. For
 *    a terminal write that is fine (see `submit_research_candidates` below).
 *    For a DATA FETCH it is fatal: under APPROVAL the drainer gets
 *    `PENDING_APPROVAL` back and can never obtain the Maps listings within its
 *    session, however fast the owner clicks, and the 30-minute lease and 24h
 *    approval TTL both run out first. So under APPROVAL these three are not
 *    queued, they are unusable, and the lane silently degrades to Claude's own
 *    web search — losing exactly the Google Maps pain signal this design calls
 *    unsubstitutable. Running the lane as designed requires AUTONOMOUS.
 *  - `submit_research_candidates` is a gated WRITE, and this one really does
 *    only WAIT. It is terminal — the client closes the job, and the approval
 *    executor replays the call hours later with the candidates intact — so the
 *    result never needing to reach the agent's turn is exactly why it survives
 *    the gate the three above do not. The design spec records the gate itself
 *    as an OPEN OWNER DECISION and explicitly does not take it: staging is
 *    reversible and already human-reviewed at `accept_research_candidates`, so
 *    there is a case for loosening it — but that is the owner's call, not this
 *    file's. Until they take it, every night's submit waits in the approval
 *    queue, and `HomeTimelineService` reports that by name rather than letting
 *    it present as an empty review queue.
 *  - `claim` and `complete` are ungated WRITEs. Claiming spends nothing and
 *    self-reverses when the lease expires; gating the CLOSE would be worse than
 *    pointless, leaving the job leased until expiry and then researched twice.
 *
 * All six are `defer: true` — the advertised catalogue has a hard ceiling, and
 * a drainer learns these names from the instruction it just claimed.
 */
function registerResearchMcpLane(registry: McpToolRegistry, deps: ResearchToolDeps): void {
  /** Everything `dispatchResearchTool` needs, minus the per-call context. */
  const sourceDeps = { sources: deps.sources, spend: deps.spend, runs: deps.runs };

  /**
   * Run one Jeeta-keyed source tool against a LEASED job.
   *
   * The run id and the geo are resolved from the server's record of that lease,
   * never from the caller's arguments: the run id is what a `ToolCallLog` and
   * an Apify/Firecrawl meter are attributed to, and the geo is the profile's
   * hard filter. Accepting either as a tool argument would let an agent bill its
   * crawling onto another workspace's run, or search outside the geo its own
   * brief promised.
   */
  const runSource = async (
    ctx: { workspaceId: string },
    jobId: string,
    tool: 'search_places' | 'lookup_instagram' | 'scrape_page',
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    await assertFeature(deps.entitlements, ctx.workspaceId, 'research');
    const leaseCtx = await deps.lease.toolContext(ctx.workspaceId, jobId);
    return dispatchResearchTool(
      sourceDeps,
      { workspaceId: leaseCtx.workspaceId, runId: leaseCtx.runId, geo: leaseCtx.geo, budgetId: null },
      tool,
      args,
    );
  };

  registry.register({
    name: 'jeeta.claim_research_job',
    description:
      "Take the next queued nightly research job for this workspace and get its full brief — who to look for, where, in which language, what disqualifies a prospect, and how to report back. Only works when the workspace has handed research execution to its own Claude (researchExecution = MCP); otherwise the platform is still running these jobs itself and this returns nothing. The job is LEASED to you for a limited time: work it, submit what you found, then close it. If you never close it the lease expires, the job goes back to the queue, and the same night gets researched twice. NOTE ON WRITE MODE: this lane is designed for AUTONOMOUS. In APPROVAL mode the three Jeeta-keyed data tools (research_search_places, research_lookup_instagram, research_scrape_page) are not merely delayed — they return PENDING_APPROVAL and their results can never reach you inside this session, no matter how quickly a human approves, because an approved call is replayed to the approver, not back into your turn. Your lease and the approval both expire first. Working a job under APPROVAL therefore means working WITHOUT Google Maps listings and their recent reviews — the primary pain signal these briefs qualify on — using only your own web search. Say so in the job you submit rather than presenting the result as a normal night.",
    domain: 'research',
    defer: true,
    scopes: ['settings.manage'],
    // A status flip on a job the cron already created. It spends nothing, and
    // an abandoned lease returns to the queue on its own.
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'research');
      const res = await deps.lease.claim(ctx.workspaceId);
      if (res.job) return { job: res.job };
      // Never a bare empty object. "No job tonight" and "this workspace is not
      // on the MCP lane at all" need opposite fixes, and a drainer that cannot
      // tell them apart polls forever against a queue the platform is already
      // draining.
      return {
        job: null,
        reason: res.reason,
        message:
          res.reason === 'not-in-mcp-mode'
            ? 'This workspace still has the PLATFORM draining its research queue (researchExecution = SERVER, not MCP), so there is nothing for you to lease and never will be until that changes. A workspace OWNER switches it under Settings > Claude connector (the "Who runs the nightly research" card); until then, stop polling.'
            : 'No research job is waiting right now. The nightly cron enqueues one job per active brief at 03:00 workspace time.',
      };
    },
  });

  registry.register({
    name: 'jeeta.submit_research_candidates',
    description:
      'Hand back the qualified prospects you found for a leased research job. These are staged as CANDIDATES for human review, NOT as leads — nobody is called, emailed or assigned until someone accepts them, and accepting is what consumes the daily lead allowance. Every candidate needs externalRef, businessName, businessType, painPoint, evidence and pitch (in the brief’s language); anything malformed is dropped, and anything already staged for this brief collapses as a duplicate. Call this once per job, then close the job.',
    domain: 'research',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    // The open owner decision (design spec): staging is reversible and already
    // reviewed downstream, but loosening this gate is the owner's call. Left
    // gated; the un-drained/awaiting-approval state is reported by name on the
    // home timeline so it cannot present as "research found nothing".
    requiresApproval: true,
    resourceType: 'research_job',
    resourceIdFrom: (args) => (typeof args.jobId === 'string' ? args.jobId : undefined),
    inputSchema: z.object({
      jobId: z.string().min(1).describe('The leased job id from jeeta.claim_research_job.'),
      candidates: z
        .array(
          z.object({
            externalRef: z
              .string()
              .min(1)
              .describe(
                'Cross-day dedup key. First applicable of phone:+<E164>, instagram:@handle, google:<placeId>, domain:<apex>, hash:<sha1(lowercase(businessName|city))>. Never randomize it.',
              ),
            businessName: z.string().min(1),
            businessType: z.string().min(1).describe('e.g. CAFE, SALON, RESTAURANT.'),
            painPoint: z.string().min(1).describe('The concrete problem, in the brief language.'),
            evidence: z.string().min(1).describe('What proves it — a quoted review, a source url.'),
            pitch: z.string().min(1).describe('How to open with them, in the brief language.'),
            city: z.string().optional(),
            region: z.string().optional(),
            phone: z.string().optional(),
            instagram: z.string().optional(),
            website: z.string().optional(),
            email: z.string().optional(),
            branchCount: z.number().int().optional(),
            currentSystem: z.string().optional(),
            stage: z.enum(['GROWING', 'STRUGGLING', 'STABLE']).optional(),
            priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
            score: z.number().min(0).max(100).optional().describe('Fit against the ICP, 0-100.'),
          }),
        )
        .max(200)
        .describe('Your final list. An empty list is a valid answer when nothing qualified.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'research');
      const res = await deps.lease.submit(
        ctx.workspaceId,
        String(args.jobId ?? ''),
        (args.candidates ?? []) as unknown[],
      );
      // `staged` can be lower than what was submitted — validation drops
      // malformed rows, the daily-allowance cap clips the batch, and the
      // contact-key dedup collapses businesses already in the queue. Say which,
      // rather than returning a count a caller would read as full success.
      return {
        ...res,
        message:
          `${res.staged} candidate(s) are now in the review queue for a human to accept. ` +
          (res.duplicates > 0
            ? `${res.duplicates} were already staged for this brief and were collapsed. `
            : '') +
          'They are not leads yet.',
      };
    },
  });

  registry.register({
    name: 'jeeta.complete_research_job',
    description:
      'Close a leased research job — successfully, or as failed with the reason. Always call this, even when you found nothing worth submitting: a job that is never closed goes back to the queue when its lease expires and gets researched all over again, which costs a second run for the same night. The reason you give is stored and shown to the workspace, so "apify returned no places for this geo" is worth more than a bare failure.',
    domain: 'research',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    // Ungated on purpose: this only ever ENDS work. Gating it would leave the
    // job leased until expiry and then researched twice — a gate that costs
    // money instead of saving it.
    requiresApproval: false,
    inputSchema: z.object({
      jobId: z.string().min(1).describe('The leased job id from jeeta.claim_research_job.'),
      status: z
        .enum(['DONE', 'FAILED'])
        .describe('DONE when you worked it (even if nothing qualified), FAILED when you could not.'),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe('Why — required in spirit for FAILED, useful for DONE with an empty result.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'research');
      return deps.lease.complete(ctx.workspaceId, String(args.jobId ?? ''), {
        status: args.status as 'DONE' | 'FAILED',
        ...(args.reason !== undefined ? { reason: String(args.reason) } : {}),
      });
    },
  });

  registry.register({
    name: 'jeeta.research_search_places',
    description:
      "Search Google Maps for businesses matching a query, inside the leased job's geo, and get back their contact details, category, rating and RECENT REVIEWS. The reviews are the point: they are the primary source of the concrete pain a candidate has to be qualified on, and general web search does not reach them. Costs Jeeta real money per call (Apify), metered against this workspace's research budget — so search deliberately, not exhaustively.",
    domain: 'research',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'SPEND',
    requiresApproval: true,
    approvalKind: 'AI_SPEND',
    inputSchema: z.object({
      jobId: z.string().min(1).describe('The leased job id from jeeta.claim_research_job.'),
      query: z.string().min(1).describe('What to look for, e.g. "kuafor izmir alsancak".'),
      limit: z.number().int().min(1).max(30).optional().describe('How many listings (1-30, default 15).'),
    }),
    handler: async (ctx, args) =>
      runSource(ctx, String(args.jobId ?? ''), 'search_places', {
        query: String(args.query ?? ''),
        ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
      }),
  });

  registry.register({
    name: 'jeeta.research_lookup_instagram',
    description:
      'Look up one Instagram business handle (bio, follower count, external link) to confirm a prospect has a reachable social channel. A prospect with no reachable contact at all is a hard disqualifier, so this is how a promising business with no listed phone still qualifies. Costs Jeeta real money per call (Apify), metered against this workspace research budget.',
    domain: 'research',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'SPEND',
    requiresApproval: true,
    approvalKind: 'AI_SPEND',
    inputSchema: z.object({
      jobId: z.string().min(1).describe('The leased job id from jeeta.claim_research_job.'),
      handle: z.string().min(1).describe('One handle, with or without the leading @.'),
    }),
    handler: async (ctx, args) =>
      runSource(ctx, String(args.jobId ?? ''), 'lookup_instagram', {
        handle: String(args.handle ?? ''),
      }),
  });

  registry.register({
    name: 'jeeta.research_scrape_page',
    description:
      "Fetch one web page as markdown to read for evidence — a prospect's own site, a directory listing, a review page. Use this when you need the CONTENT of a specific page rather than a search result summary. Costs Jeeta real money per page (Firecrawl, falling back to the platform's own fetcher), metered against this workspace research budget.",
    domain: 'research',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'SPEND',
    requiresApproval: true,
    approvalKind: 'AI_SPEND',
    inputSchema: z.object({
      jobId: z.string().min(1).describe('The leased job id from jeeta.claim_research_job.'),
      url: z.string().min(1).describe('The absolute URL of the page to read.'),
    }),
    handler: async (ctx, args) =>
      runSource(ctx, String(args.jobId ?? ''), 'scrape_page', { url: String(args.url ?? '') }),
  });
}
