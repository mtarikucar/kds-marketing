import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { ConversationsService } from '../../channels/conversations.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface ConversationWriteToolDeps {
  conversations: ConversationsService;
  principals: McpPrincipalService;
  entitlements: EntitlementsService;
}

/**
 * Faz 5 D3 — shared-inbox management (as opposed to `inbox.tools.ts`, which
 * reads threads and replies to customers).
 *
 * None of these reaches a customer: assigning, closing and annotating a
 * conversation are internal triage acts, visible only to the team. They are
 * therefore plain `WRITE`s with no approval gate — the same treatment D1 gave
 * `jeeta.set_lead_status` and `jeeta.add_lead_note`, and for the same reason: a
 * wrong one is visible in the panel and trivially reversible (`reopen`, a
 * second assign), unlike a message that has already been delivered.
 *
 * ## There is no `tag_conversation`, because there are no conversation tags
 * The `Conversation` model has no tags column and `ConversationsService`
 * exposes no tagging method — status (`close`/`reopen`), assignment and
 * internal notes are the whole vocabulary. Registering a `jeeta.tag_conversation`
 * would have meant either inventing a tag store no panel surface reads, or
 * quietly retagging the conversation's LEAD and calling it something it is not.
 * `jeeta.add_conversation_note` is the real mechanism for "mark this thread as
 * X for the team", so that is what is registered instead.
 *
 * Gated on the `conversationAi` package feature, matching
 * `@RequiresFeature('conversationAi')` on `MarketingConversationsController` —
 * a workspace whose package does not include the shared inbox cannot reach it
 * through MCP either.
 */
export function registerConversationWriteTools(
  registry: McpToolRegistry,
  deps: ConversationWriteToolDeps,
): void {
  registry.register({
    name: 'jeeta.assign_conversation',
    description:
      'Assign a conversation to a teammate, or unassign it by omitting the user id. Internal triage — the customer sees nothing.',
    domain: 'inbox',
    // Deferred in D4 (spec §3): inbox still advertises list/read/send plus
    // `jeeta.close_conversation`; routing a thread to a named teammate is the
    // rarest of the triage verbs for an agent working on its own.
    defer: true,
    scopes: ['contacts.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      conversationId: z.string().min(1).describe('Conversation id to assign.'),
      assignedToId: z
        .string()
        .optional()
        .describe('Id of the teammate to assign it to. Omit to clear the assignment.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      const assignedToId = typeof args.assignedToId === 'string' ? args.assignedToId : null;
      if (assignedToId) {
        // Same guard `jeeta.assign_lead` uses: the target must be an ACTIVE
        // member of the CALLER's workspace and not the automation principal
        // (which can never log in, so work parked on it is work nobody sees).
        // `ConversationsService.assign` only checks workspace membership.
        await deps.principals.assertActiveMember(ctx.workspaceId, assignedToId);
      }
      return deps.conversations.assign(ctx.workspaceId, String(args.conversationId ?? ''), assignedToId);
    },
  });

  registry.register({
    name: 'jeeta.close_conversation',
    description:
      'Close a conversation as handled, or reopen a closed one. Internal triage — the customer sees nothing and can still reply, which reopens the thread on its own.',
    domain: 'inbox',
    scopes: ['contacts.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      conversationId: z.string().min(1).describe('Conversation id.'),
      reopen: z
        .boolean()
        .optional()
        .describe('Set true to reopen a closed conversation instead of closing it.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      const conversationId = String(args.conversationId ?? '');
      return args.reopen === true
        ? deps.conversations.reopen(ctx.workspaceId, conversationId)
        : deps.conversations.close(ctx.workspaceId, conversationId);
    },
  });

  registry.register({
    name: 'jeeta.add_conversation_note',
    description:
      'Add an internal note to a conversation — the way to label or hand off a thread for the team. The customer never sees it. This is NOT a reply; use jeeta.send_message to write to the customer.',
    domain: 'inbox',
    // Deferred (spec §3): internal annotation, useful but not a per-turn action.
    defer: true,
    scopes: ['contacts.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      conversationId: z.string().min(1).describe('Conversation id to annotate.'),
      body: z.string().min(1).max(5000).describe('Note text, visible only to your team.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      // `ConversationNote.authorId` is a real FK — resolve a genuine principal
      // rather than fabricating an id (see McpPrincipalService).
      const actor = await deps.principals.resolve(ctx);
      return deps.conversations.addNote(
        ctx.workspaceId,
        String(args.conversationId ?? ''),
        actor.id,
        String(args.body ?? ''),
      );
    },
  });
}
