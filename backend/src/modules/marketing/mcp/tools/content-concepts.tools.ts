import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import {
  CONCEPT_LIST_LIMIT,
  CONCEPT_STATUSES,
  ContentConceptsService,
  MAX_CONCEPT_COUNT,
  MIN_CONCEPT_COUNT,
  DEFAULT_CONCEPT_COUNT,
  MIN_SHOT_SEC,
  MAX_SHOT_SEC,
  type SubmittedConcept,
} from '../../content-concepts/content-concepts.service';
import { MIN_SHOTS_PER_CONCEPT } from '../../content-concepts/concept-distinctness';
import { assertFeature } from '../mcp-feature-gate';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ContentConceptToolDeps {
  concepts: ContentConceptsService;
  principals: McpPrincipalService;
  entitlements: EntitlementsService;
}

const VIDEO_MODELS = ['seedance', 'veo', 'kling', 'higgsfield'] as const;
const DECISIONS = ['APPROVED', 'DISCARDED'] as const;

/**
 * İçerik üretim hattı, aşama 1 — the idea -> concepts step, reachable from the
 * chat, plus the repair for stage 2 stalling.
 *
 * The owner's chosen entry point is `POST /marketing/ai/command`, which runs the
 * model against this very catalogue through `McpBrokerService`. So the feature
 * ships as tools rather than as a new screen: pasting an idea into the chat and
 * asking for content has to REACH something, and this is it.
 *
 * ## Why `plan_content_concepts` runs without an approval
 *
 * It costs money — 16 AI credits, one Opus call — so the instinct is to reach
 * for an approval gate. Not gating it is deliberate, and the mechanism is worth
 * stating exactly, because an earlier version of this comment stated it wrongly
 * and a wrong story here is how the next tool gets classified badly.
 *
 * **The gate is `requiresApproval`, not `risk`.** One line in
 * `McpBrokerService.invoke` decides:
 * `if (tool.requiresApproval && !autonomyMayBypass && !ctx.approvedBy)`. `risk`
 * reaches behaviour only through `ALWAYS_APPROVED_RISKS`, which holds
 * `DESTRUCTIVE` and nothing else, and otherwise only prints as a label in
 * `jeeta.find_tools`. So `risk: 'WRITE'` is not what keeps this tool inline —
 * `requiresApproval: false` is — and relabelling it `SPEND` would not gate it.
 * The two are genuinely independent: `jeeta.synthesize_strategy` and
 * `jeeta.run_research` are `SPEND` with `approvalKind: 'AI_SPEND'`, and what
 * queues them is their own `requiresApproval: true`.
 *
 * **Why ungated is the right call.** Credit-metered Anthropic spend is bounded
 * by the workspace's own balance, which is the owner's stated policy — the same
 * reasoning that took `SPEND` out of `ALWAYS_APPROVED_RISKS` (see that set's
 * docblock: *"panelden izin alacaksak ne anlamı kaldı MCP'nin"*). A wrong turn
 * here costs credits the owner already caps; it cannot overdraw anything.
 *
 * **What gating it would cost.** v2.286.0 measured the other side: a gated call
 * comes back `PENDING_APPROVAL`, and the approval executor hands the result to
 * the APPROVER's HTTP response, not to the agent turn that asked. For a tool
 * whose entire value IS its return value, the one surface this feature exists
 * for would be the one surface it cannot be used from.
 *
 * `risk: 'WRITE'` is then simply the truthful label for what it does to
 * workspace data: it writes inert, reviewable rows a human discards for free.
 * The description says plainly that credits are spent, so the model is told even
 * though nothing stops it.
 *
 * ## Why the review tool refuses a session with no human
 *
 * Every other write tool here falls back to `McpPrincipalService.resolve` (the
 * workspace's SYSTEM sentinel) when no person is behind the call. This one does
 * not, and the difference is the point: an unattended agent approving its own
 * concepts is not a review being performed, it is a review being deleted, and
 * there is no honest value to write into `reviewedById`. A signed-in human on
 * the chat lane satisfies it; an API-key MCP session does not.
 *
 * ## Why there is a fourth tool, and why it needs no human
 *
 * `ConceptPromotionService.promote` had exactly ONE caller — `review()` — and
 * `review()` refuses a concept it has already decided. Any failure between the
 * verdict write and the item (the campaign deleted in the pre-flight window, a
 * deadlock, the enqueue throwing) therefore left the concept APPROVED with
 * `promotedItemId` null and every surface answering "already approved and cannot
 * be decided again", permanently; and an item created but never enqueued sat at
 * `GENERATING`, which `REGENERATABLE_STATES` excludes. There was no controller,
 * no route and no tool that could reach either. `jeeta.produce_content_concept`
 * is that second caller.
 *
 * It is a TOOL rather than a REST route because there is no content-concepts
 * controller to add a route to and no screen that would call one: this whole
 * feature is reached through `POST /marketing/ai/command`, which runs the model
 * against this catalogue. A route would have been a surface with no caller, and
 * the moment the repair is needed is the moment a human is reading
 * `jeeta.list_content_concepts` and seeing an APPROVED concept with no item.
 *
 * Unlike the review tool it does NOT require a signed-in human. The distinction
 * is what the call writes: `review` records a person's verdict in
 * `reviewedById`, and an unattended session has nothing honest to put there.
 * This tool records no verdict — it acts on one already on the row — and adding
 * a human gate would only make the repair unreachable from the lane the problem
 * is noticed in.
 *
 * All four sit behind the `socialCampaigns` package feature — the same gate the
 * campaign engine these concepts feed runs behind.
 */
export function registerContentConceptTools(
  registry: McpToolRegistry,
  deps: ContentConceptToolDeps,
): void {
  registry.register({
    name: 'jeeta.plan_content_concepts',
    description:
      `Turn ONE idea (pasted text, notes, a link) into several genuinely DIFFERENT video concepts — different angles, not rewordings — each planned shot by shot with its own on-screen text, voiceover, camera note and duration. Defaults to ${DEFAULT_CONCEPT_COUNT} concepts. This SPENDS AI credits (one Opus call). The concepts are saved as PROPOSED for a human to approve or discard with jeeta.review_content_concept; nothing is generated or published here. APPROVING one later REQUIRES a social campaign to produce it into, and that campaign must be ACTIVE or PAUSED — a DRAFT campaign is refused, because the publish gate would never release what approving it would pay to generate. Pass socialCampaignId now to have that checked BEFORE this call spends anything, or leave it off and let the reviewer name one. If the concepts come back as variations of one another the whole batch is refused and nothing is saved — that is a generation failure, not a verdict on the idea. Each returned plan carries a "production" block: the model that will actually run it, the seconds each beat will be BILLED at (a model's own contract floor can raise a 3-second beat to 4), and what producing it costs in credits and dollars. That is the price approving it will charge — show it before approving, and note that a persona forces the reference-to-video model, which is many times dearer per second than the default. When socialCampaignId is given, each concept also carries "destinations": one line per target account saying what that network will ACTUALLY publish (all clips as a carousel, the first beat only, or nothing at all on a network that cannot carry video) — show those lines before approving, because nothing is refused over capacity.`,
    domain: 'content',
    // Deferred (spec §3): the advertised surface is at its 45-tool ceiling, and
    // a wave that wants room must defer rather than raise the number. Reachable
    // from the chat via jeeta.find_tools -> jeeta.call_tool, which is the
    // mechanism the ceiling exists to fund.
    defer: true,
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      idea: z
        .string()
        .min(1)
        .max(4000)
        .describe('The idea to open up — pasted text, rough notes, or a description of a link.'),
      count: z
        .number()
        .int()
        .min(MIN_CONCEPT_COUNT)
        .max(MAX_CONCEPT_COUNT)
        .optional()
        .describe(`How many distinct concepts to produce (${MIN_CONCEPT_COUNT}-${MAX_CONCEPT_COUNT}). Defaults to ${DEFAULT_CONCEPT_COUNT}.`),
      videoModel: z
        .enum(VIDEO_MODELS)
        .optional()
        .describe('Which video model the shot prompts should be formatted for. Defaults to seedance.'),
      socialCampaignId: z
        .string()
        .max(64)
        .optional()
        .describe('Scope these concepts to an existing ACTIVE or PAUSED social campaign (see jeeta.list_social_campaigns). Validated before any credits are spent.'),
      personaId: z
        .string()
        .max(64)
        .optional()
        .describe('A VideoPersona whose reference images lock ONE face or product across every shot of every concept, so the clips read as one campaign rather than unrelated videos. The persona must have at least one reference image; validated before any credits are spent. It also CHANGES THE MODEL and the price: reference frames only work on the reference-to-video endpoint (48 credits/second against the default 3, with a 4-second minimum beat), and the returned plan quotes exactly that.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      // The signed-in human when there is one; the workspace's service sentinel
      // otherwise — `createdById` is authorship, not authority.
      const createdById = ctx.userId ?? (await deps.principals.resolve(ctx)).id;
      return deps.concepts.planConcepts(ctx.workspaceId, {
        idea: String(args.idea ?? ''),
        ...(typeof args.count === 'number' ? { count: args.count } : {}),
        ...(args.videoModel !== undefined ? { videoModel: args.videoModel as never } : {}),
        ...(args.socialCampaignId !== undefined
          ? { socialCampaignId: String(args.socialCampaignId) }
          : {}),
        ...(args.personaId !== undefined ? { personaId: String(args.personaId) } : {}),
        createdById,
      });
    },
  });

  registry.register({
    name: 'jeeta.list_content_concepts',
    description:
      `List the video concepts in this workspace with their angle, hook and full shot plan, newest batch first. Returns at most the ${CONCEPT_LIST_LIMIT} newest concepts (about five batches); older ones are reachable only by narrowing. Filter by status (PROPOSED = waiting on a human, APPROVED = kept, DISCARDED = rejected) or by batchId, which always returns that batch whole. Every concept scoped to a campaign carries "destinations": one line per target account saying what that network will ACTUALLY publish if it is approved — the whole set of clips as a carousel, the first beat only, nothing at all on a network that cannot carry video, or nothing because the account is disconnected. Show those lines to the human before they approve. Read-only.`,
    domain: 'content',
    // Deferred (spec §3): a review-queue browse, not a per-turn action.
    defer: true,
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      status: z.enum(CONCEPT_STATUSES).optional().describe('Restrict to one review status.'),
      batchId: z
        .string()
        .max(64)
        .optional()
        .describe('Only the concepts distilled from one idea (returned by jeeta.plan_content_concepts).'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      return deps.concepts.list(ctx.workspaceId, {
        ...(args.status !== undefined ? { status: String(args.status) } : {}),
        ...(args.batchId !== undefined ? { batchId: String(args.batchId) } : {}),
      });
    },
  });

  /**
   * THE GATING ASYMMETRY ON THIS TOOL, RECORDED AS A DECISION.
   *
   * `jeeta.review_content_concept` is `risk: 'WRITE'`, `requiresApproval: false`
   * — and approving one concept triggers N video generations server-side, one
   * per beat of its shot plan. That is the LARGEST single spend anything in this
   * catalogue can start. `jeeta.generate_video`, which buys exactly ONE clip, is
   * `risk: 'SPEND'` with `requiresApproval: true` and `approvalKind:
   * 'MEDIA_SPEND'`, so it queues for a human in every write mode including
   * AUTONOMOUS. The bigger spend is gated LESS than the smaller one.
   *
   * That is not an oversight, and the reason is what `requiresApproval` gates.
   * It gates the CALL, and the caller here is a human: the tool refuses outright
   * when `ctx.userId` is absent ("this session has no person behind it, and
   * there is nothing honest to record as the reviewer"), so an unattended
   * API-key session cannot reach the spend at all. The approval card would be
   * asking the person who just approved the concept to approve their own
   * approval. `generate_video` carries no such requirement — an unattended
   * session CAN call it — which is exactly why it needs the broker's gate.
   *
   * The concept docblock in `ConceptPromotionService` argues the rest: routing
   * the clips through `generate_video` instead would raise N approval cards for
   * one decision, and the approval executor returns the tool result to the
   * APPROVER's HTTP response rather than the agent's turn, so the `assetId`
   * would never reach anything that could record it on the item.
   *
   * So the gate is the signed-in reviewer, once, on the idea — which is the
   * shape the owner asked for. Do NOT "fix" this by adding `requiresApproval`
   * or by reclassifying the risk; if the trade is to be revisited, it is the
   * `ctx.userId` requirement and the N-cards problem that have to be revisited
   * with it.
   */
  registry.register({
    name: 'jeeta.review_content_concept',
    description:
      'Approve or discard one proposed video concept on behalf of the signed-in person. APPROVING STARTS PRODUCTION: the concept becomes a social-campaign item and one video clip is generated per beat of its shot plan, which SPENDS the workspace credits (video is the most expensive action in the product) — this single decision is the whole human gate, there is no second approval per clip. Discarding takes it out of the queue and costs nothing. A concept can only be decided once. Approval needs a social campaign to produce into — the one the idea was scoped to, or socialCampaignId — and that campaign must be ACTIVE or PAUSED; a DRAFT campaign is refused BEFORE the verdict is recorded, so the concept stays PROPOSED and can be approved again once someone activates the campaign in the panel. Approval is NOT refused because a destination cannot carry every clip — each network takes what it can (the Instagram feed carousel holds ten, TikTok and Facebook take one, X and Pinterest take no video at all) and the rest is recorded; read the "destinations" lines from jeeta.list_content_concepts to the person first, so they approve knowing what each account will receive. Requires a signed-in human — an unattended API-key session cannot sign off its own concepts.',
    domain: 'content',
    // Deferred (spec §3): follows list_content_concepts, which is itself
    // deferred; a model that has found one has found both.
    defer: true,
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      conceptId: z.string().min(1).max(64).describe('The concept to decide (see jeeta.list_content_concepts).'),
      decision: z.enum(DECISIONS).describe('APPROVED keeps it for production; DISCARDED drops it.'),
      note: z.string().max(1000).optional().describe("The person's reason, in their own words."),
      socialCampaignId: z
        .string()
        .max(64)
        .optional()
        .describe(
          'Which ACTIVE or PAUSED social campaign to produce this concept into (see jeeta.list_social_campaigns). Required when the concept was not already scoped to one — the campaign carries the calendar slot, the target accounts and the video model. Ignored when discarding.',
        ),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      if (!ctx.userId) {
        throw new ForbiddenException(
          'Reviewing a concept requires a signed-in human — this session has no person behind it, and there is nothing honest to record as the reviewer.',
        );
      }
      return deps.concepts.review(ctx.workspaceId, String(args.conceptId), {
        decision: args.decision as 'APPROVED' | 'DISCARDED',
        reviewerId: ctx.userId,
        ...(args.note !== undefined ? { note: String(args.note) } : {}),
        ...(args.socialCampaignId !== undefined
          ? { socialCampaignId: String(args.socialCampaignId) }
          : {}),
      });
    },
  });

  registry.register({
    name: 'jeeta.produce_content_concept',
    description:
      'Produce a concept a human ALREADY APPROVED — the repair for an approved concept that never became a campaign item. Use it when jeeta.list_content_concepts shows a concept APPROVED with no promotedItemId, or an item stuck GENERATING with nothing happening: approval and production are two steps, and a crash between them used to be unrecoverable because a concept can only be decided once. Safe to call repeatedly — a concept already produced is returned unchanged and buys nothing, and a partly produced one resumes at the next unbought beat rather than re-buying the clips it already owns. It DOES spend when the concept was approved and never produced: one video clip per beat of its shot plan. It approves nothing; only jeeta.review_content_concept can do that.',
    domain: 'content',
    // Deferred (spec §3): a repair reached after list_content_concepts, which is
    // itself deferred — and the advertised surface stays at its 45-tool ceiling.
    defer: true,
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      conceptId: z
        .string()
        .min(1)
        .max(64)
        .describe('The APPROVED concept to produce (see jeeta.list_content_concepts).'),
      socialCampaignId: z
        .string()
        .max(64)
        .optional()
        .describe(
          'Which ACTIVE or PAUSED social campaign to produce into (see jeeta.list_social_campaigns). Only needed when the concept is not already scoped to one, or when the campaign it named has since been deleted.',
        ),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      return deps.concepts.produce(ctx.workspaceId, String(args.conceptId), {
        ...(args.socialCampaignId !== undefined
          ? { socialCampaignId: String(args.socialCampaignId) }
          : {}),
      });
    },
  });

  registry.register({
    name: 'jeeta.submit_content_concepts',
    description:
      `Save video concepts YOU planned yourself, instead of paying the platform's model to plan them for you. This is the preferred way to create concepts when you are a connected Claude: you already have the brand context, and jeeta.plan_content_concepts would only be you asking the server to ask another model — a round trip that costs the workspace AI credits and stops working entirely whenever the platform's own key is dry. This call spends NO credits. Everything else is identical: the same distinctness contract, the same beat-length clamp, the same campaign and persona locks, the same production quote and destination lines come back on the result. Read jeeta.get_brand_profile first and write in that voice. The batch is REFUSED WHOLE if the concepts are variations of one another — each needs a genuinely different angle (not a reworded hook), a distinct hook, and at least ${MIN_SHOTS_PER_CONCEPT} shots each with a visual description. Beats outside ${MIN_SHOT_SEC}-${MAX_SHOT_SEC}s are clamped to what the generator accepts. Concepts are saved as PROPOSED for a human to approve with jeeta.review_content_concept; nothing is generated or published here.`,
    domain: 'content',
    defer: true,
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      idea: z
        .string()
        .min(1)
        .describe('The idea these concepts came from, recorded on every row so a reviewer can see what was asked for.'),
      concepts: z
        .array(
          z.object({
            angle: z.string().min(1).describe('The distinct take this concept argues. Two concepts sharing an angle are one concept.'),
            hook: z.string().min(1).describe('The opening line or image. Must not be a rewording of the hook on any other concept in the batch.'),
            title: z.string().optional().describe('Short label for the reviewer. Defaults to the hook.'),
            rationale: z.string().nullable().optional().describe('Why this angle is worth shooting.'),
            shots: z
              .array(
                z.object({
                  scene: z.string().optional().describe('Short label for the beat.'),
                  description: z.string().min(1).describe('What is IN FRAME. Required — a beat with no visual description renders as an empty prompt.'),
                  cameraNote: z.string().optional().describe('Framing or camera-movement note for the shot.'),
                  onScreenText: z.string().optional().describe('Text burned into the frame. Empty for none.'),
                  voiceover: z.string().optional().describe('Spoken line. Empty for a silent beat, which is legitimate.'),
                  durationSec: z
                    .number()
                    .optional()
                    .describe(`Seconds for this beat, ${MIN_SHOT_SEC}-${MAX_SHOT_SEC}. Omit to let the planner split evenly; out-of-range values are clamped.`),
                }),
              )
              .min(MIN_SHOTS_PER_CONCEPT)
              .describe('The beats, in order. A concept is planned shot by shot.'),
          }),
        )
        .min(MIN_CONCEPT_COUNT)
        .max(MAX_CONCEPT_COUNT)
        .describe('The concepts you planned. Must be at least as many as `count` asks for.'),
      count: z
        .number()
        .int()
        .min(MIN_CONCEPT_COUNT)
        .max(MAX_CONCEPT_COUNT)
        .optional()
        .describe(`How many the batch is expected to contain. Defaults to ${DEFAULT_CONCEPT_COUNT}; submitting fewer than this is refused whole.`),
      videoModel: z
        .enum(VIDEO_MODELS)
        .optional()
        .describe('Which video model the shot prompts are formatted for. Defaults to seedance.'),
      socialCampaignId: z
        .string()
        .max(64)
        .optional()
        .describe('Scope to an ACTIVE or PAUSED social campaign, which is what approving one later requires. Validated here.'),
      personaId: z
        .string()
        .max(64)
        .optional()
        .describe('A VideoPersona locking one face or product across every shot. CHANGES THE PRICE of producing the batch — reference frames only run on the reference-to-video endpoint; the returned plan quotes it.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      const createdById = ctx.userId ?? (await deps.principals.resolve(ctx)).id;
      return deps.concepts.submitConcepts(
        ctx.workspaceId,
        {
          idea: String(args.idea ?? ''),
          ...(typeof args.count === 'number' ? { count: args.count } : {}),
          ...(args.videoModel !== undefined ? { videoModel: args.videoModel as never } : {}),
          ...(args.socialCampaignId !== undefined
            ? { socialCampaignId: String(args.socialCampaignId) }
            : {}),
          ...(args.personaId !== undefined ? { personaId: String(args.personaId) } : {}),
          createdById,
        },
        args.concepts as SubmittedConcept[],
      );
    },
  });

}
