import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { ReviewsService } from '../../reviews/reviews.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ReviewToolDeps {
  reviews: ReviewsService;
  entitlements: EntitlementsService;
}

/**
 * Faz 5 D5 — reputation.
 *
 * ## Replying does NOT publish. That is a finding, not a design choice.
 *
 * D5 was scoped believing `reply_to_review` speaks publicly under the
 * business's name. It does not — today. `ReviewsService.saveReply` is a
 * workspace-scoped lookup plus `prisma.review.update({ replyText, status:
 * 'REPLIED' })`, and nothing else. There is no Google Business Profile reply
 * call anywhere in the repository: `review-clients.ts` only GETs
 * (`mybusiness.googleapis.com/v4/{account}/reviews` and the Facebook page
 * ratings feed), the `business.manage` OAuth scope is requested but never used
 * for a write, and the panel's own button reads "Save reply". The words sit in
 * Jeeta until a human pastes them into Google.
 *
 * The tool's description says so plainly, because a model that believes it
 * posted to Google will TELL the user it posted to Google — and then nobody
 * goes and pastes it.
 *
 * ## It is approval-gated all the same
 *
 * Not because of the name, but for two concrete reasons:
 *
 *  1. The text IS the brand's public voice, one copy-paste from publication —
 *     that is the field's entire purpose. An agent apologising, admitting fault
 *     or promising a refund under a one-star review writes a sentence the
 *     business will be held to.
 *  2. The status flip to `REPLIED` RETIRES the review from the team's queue.
 *     A complaint marked answered that nobody actually answered in public is
 *     worse than an unanswered one: it is now invisible to the person who would
 *     have handled it.
 *
 * `approvalKind: 'PUBLISH'` rather than `SEND`: nothing is delivered to an
 * individual, this is speech aimed at an audience — the same shape as
 * `jeeta.publish_social_post`. If the GBP write path ever lands, this
 * classification is already correct and only the description needs updating.
 *
 * ## What is deliberately not a tool here
 *
 * - `draftReply` — it reserves AI credits and calls Anthropic to write a reply.
 *   An MCP caller IS a model; spending the workspace's credits to generate text
 *   the caller can write itself is pure waste.
 * - `requestReview` — it mints a review-gate link but sends nothing; the
 *   sending is a workflow action (`send_review_request`) that pairs it with a
 *   message. Exposing the link-minting half alone would produce dangling
 *   `REQUESTED` rows nobody ever receives.
 * - `createSource`/`connectSource` — connecting a Google Business Profile is an
 *   OAuth consent a human performs; the tool would only ever half-work.
 */
export function registerReviewTools(registry: McpToolRegistry, deps: ReviewToolDeps): void {
  registry.register({
    name: 'jeeta.list_reviews',
    description:
      "List the workspace's most recent customer reviews and review requests — rating, text, author, source and status (REQUESTED, PUBLIC_ROUTED for a happy customer sent on to Google, PRIVATE_FEEDBACK for an unhappy one kept internal, REPLIED). Read-only.",
    domain: 'reviews',
    // MarketingReviewsController is @MarketingRoles('MANAGER') behind
    // @RequiresFeature('reviews'); MCP has no role for an API-key session, so
    // the manager-tier scope its mutations demand carries the whole controller.
    scopes: ['settings.manage'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'reviews');
      return deps.reviews.list(ctx.workspaceId);
    },
  });

  registry.register({
    name: 'jeeta.reply_to_review',
    description:
      'Write the business\'s reply to a customer review and mark the review as replied. Read this carefully: Jeeta does not post the reply to Google or Facebook — publishing there is not automatic, so someone still has to paste it into the platform. What this DOES do is put words in the business\'s public voice and take the review out of the team\'s "needs a reply" queue, so it is queued for a human approval first.',
    domain: 'reviews',
    // Deferred (spec §3): `jeeta.list_reviews` is the domain's advertised read;
    // replying is a gated, occasional verb.
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'PUBLISH',
    // Supersede key: a retried turn must not leave two live cards each
    // proposing different words for the same review.
    resourceType: 'review',
    resourceIdFrom: (args) => (typeof args.reviewId === 'string' ? args.reviewId : undefined),
    inputSchema: z.object({
      reviewId: z.string().min(1).describe('Review id, from jeeta.list_reviews.'),
      text: z
        .string()
        .min(1)
        // Same ceiling the REST DTO enforces (@MaxLength(4000)).
        .max(4000)
        .describe('The reply, written as the business. Assume it will be read in public.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'reviews');
      return deps.reviews.saveReply(ctx.workspaceId, String(args.reviewId ?? ''), String(args.text ?? ''));
    },
  });
}
