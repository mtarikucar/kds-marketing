import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { ContentDistributionService } from '../../distribution/content-distribution.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ContentDistributionToolDeps {
  distribution: ContentDistributionService;
  principals: McpPrincipalService;
  entitlements: EntitlementsService;
}

/**
 * İçerik üretim hattı, aşama 4 — the distribution plan, from the chat.
 *
 * ## THE THING THIS FILE DOES NOT CONTAIN
 *
 * There is no `jeeta.send_distribution_draft`, and its absence is the design,
 * not an omission. The owner chose the shape and gave the reason: automated
 * mass DMs to accounts that never asked to hear from us are what platform spam
 * detection is built to catch, and the cost is a restricted account.
 *
 * "But it could be `requiresApproval: true`" is the obvious objection and it is
 * answered by what that flag actually is. `requiresApproval` gates a call at the
 * WORKSPACE level: `AUTONOMOUS` mode bypasses it for everything except
 * `DESTRUCTIVE` (`McpBrokerService.ALWAYS_APPROVED_RISKS`, which holds that one
 * risk and nothing else). So an approval-gated send tool is a send tool that
 * ONE settings toggle turns into an unattended one — and the owner's decision
 * was per-message, not per-workspace.
 *
 * Sending is `POST marketing/content-distribution/drafts/:id/send`, where the
 * actor is `@CurrentMarketingUser()` and `DistributionSendService` verifies
 * that principal is an active human of the workspace before anything is
 * dispatched. A model can prepare the outreach and read what it prepared. It
 * has no verb that sends.
 *
 * `distribution-send.boundary.spec.ts` fails if that stops being true.
 *
 * ## Why planning needs no approval
 *
 * Same reasoning as `jeeta.plan_content_concepts`, and for a stronger reason:
 * this one spends nothing at all. It writes inert rows — a plan document and a
 * set of unsent drafts — that a human discards for free. `risk: 'WRITE'` is the
 * truthful label for that.
 */
export function registerContentDistributionTools(
  registry: McpToolRegistry,
  deps: ContentDistributionToolDeps,
): void {
  registry.register({
    name: 'jeeta.plan_content_distribution',
    description:
      'Produce a distribution plan for an APPROVED, SCHEDULED or PUBLISHED campaign item: which connected networks to cross-post to and when, which of this workspace\'s own accounts and hashtags to tag, and a prepared message for each contactable person in the CRM. NOTHING IS SENT — the messages are saved as unsent drafts and a person sends them one at a time from the panel; there is deliberately no tool that sends one. Refuses when the workspace has no connected social account, because there would be nowhere to cross-post and nothing to tag. Parts of the plan that could not be produced are returned as `gaps` with reasons, never as empty lists.',
    domain: 'social',
    // Deferred (spec section 3): the advertised surface is at its 45-tool
    // ceiling, and a wave that wants room defers rather than raising it.
    defer: true,
    scopes: ['campaigns.write'],
    risk: 'WRITE',
    requiresApproval: false,
    resourceType: 'social_campaign_item',
    resourceIdFrom: (args) =>
      typeof args.campaignItemId === 'string' ? args.campaignItemId : undefined,
    inputSchema: z.object({
      campaignItemId: z
        .string()
        .min(1)
        .max(64)
        .describe(
          'The campaign item (calendar slot) whose video is being distributed. Must be APPROVED, SCHEDULED or PUBLISHED.',
        ),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      // The SYSTEM sentinel is acceptable HERE — planning writes inert rows and
      // records who asked for them. It is NOT acceptable at the send, which is
      // the one place this feature refuses it by name.
      const createdById = ctx.userId ?? (await deps.principals.resolve(ctx)).id;
      return deps.distribution.plan(ctx.workspaceId, String(args.campaignItemId), createdById);
    },
  });

  registry.register({
    name: 'jeeta.list_distribution_drafts',
    description:
      'List the prepared outreach messages for this workspace and their state: DRAFT (waiting for a person to send it), SENT, DISMISSED or FAILED. Reading this is how you find out what is still waiting on a human — you cannot send one from here.',
    domain: 'social',
    defer: true,
    scopes: ['campaigns.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      planId: z.string().max(64).optional().describe('Only drafts from this distribution plan.'),
      status: z
        .enum(['DRAFT', 'SENT', 'DISMISSED', 'FAILED'])
        .optional()
        .describe('Only drafts in this state.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'socialCampaigns');
      return deps.distribution.listDrafts(ctx.workspaceId, {
        ...(args.planId !== undefined ? { planId: String(args.planId) } : {}),
        ...(args.status !== undefined ? { status: String(args.status) } : {}),
      });
    },
  });
}
