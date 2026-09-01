import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import {
  ContentConceptsService,
  MAX_CONCEPT_COUNT,
  MIN_CONCEPT_COUNT,
  DEFAULT_CONCEPT_COUNT,
} from '../../content-concepts/content-concepts.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ContentConceptToolDeps {
  concepts: ContentConceptsService;
  principals: McpPrincipalService;
  entitlements: EntitlementsService;
}

const VIDEO_MODELS = ['seedance', 'veo', 'kling', 'higgsfield'] as const;
const CONCEPT_STATUSES = ['PROPOSED', 'APPROVED', 'DISCARDED'] as const;
const DECISIONS = ['APPROVED', 'DISCARDED'] as const;

/**
 * İçerik üretim hattı, aşama 1 — the idea -> concepts step, reachable from the
 * chat.
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
 * All three sit behind the `socialCampaigns` package feature — the same gate the
 * campaign engine these concepts feed runs behind.
 */
export function registerContentConceptTools(
  registry: McpToolRegistry,
  deps: ContentConceptToolDeps,
): void {
  registry.register({
    name: 'jeeta.plan_content_concepts',
    description:
      `Turn ONE idea (pasted text, notes, a link) into several genuinely DIFFERENT video concepts — different angles, not rewordings — each planned shot by shot with its own on-screen text, voiceover, camera note and duration. Defaults to ${DEFAULT_CONCEPT_COUNT} concepts. This SPENDS AI credits (one Opus call). The concepts are saved as PROPOSED for a human to approve or discard with jeeta.review_content_concept; nothing is generated or published. If the concepts come back as variations of one another the whole batch is refused and nothing is saved — that is a generation failure, not a verdict on the idea.`,
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
        .describe('Scope these concepts to an existing social campaign (see jeeta.list_social_campaigns).'),
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
        createdById,
      });
    },
  });

  registry.register({
    name: 'jeeta.list_content_concepts',
    description:
      'List the video concepts in this workspace with their angle, hook and full shot plan, newest batch first. Filter by status (PROPOSED = waiting on a human, APPROVED = kept, DISCARDED = rejected) or by batchId to see the concepts that came out of one idea. Read-only.',
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

  registry.register({
    name: 'jeeta.review_content_concept',
    description:
      'Approve or discard one proposed video concept on behalf of the signed-in person. Approving marks it as the one to produce; discarding takes it out of the queue. A concept can only be decided once. Requires a signed-in human — an unattended API-key session cannot sign off its own concepts.',
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
      });
    },
  });
}
