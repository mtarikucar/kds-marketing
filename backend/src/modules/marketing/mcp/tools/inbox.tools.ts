import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { ConversationsService } from '../../channels/conversations.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface InboxToolDeps {
  conversations: ConversationsService;
  entitlements: EntitlementsService;
}

/**
 * Shared-inbox tools: two ungated reads (list/read a conversation) and one
 * approval-gated write (send a reply). `jeeta.send_message` reaches a real
 * customer, so it is registered `requiresApproval: true` — the broker
 * (`mcp-broker.service.ts`) enqueues a human approval instead of ever running
 * this handler inline unless the workspace's writeMode is AUTONOMOUS.
 *
 * ## The `conversationAi` gate (added in Faz 5 D5)
 *
 * Every route on `MarketingConversationsController` is
 * `@RequiresFeature('conversationAi')`. These three tools shipped in Faz 1-2,
 * before `assertFeature` existed, and were still missing that check when D3
 * added the inbox WRITE tools (`conversations-write.tools.ts`) WITH it — an
 * inconsistency D3 flagged and this closes. Until now a workspace whose package
 * excludes the shared inbox could still, over MCP, list its conversations, read
 * a customer's entire message history and send that customer a reply: the
 * package boundary held over REST and leaked over MCP. The refusal is the same
 * `FEATURE_NOT_IN_PACKAGE` sentence the REST gate produces, so an agent can
 * relay it.
 */
export function registerInboxTools(registry: McpToolRegistry, deps: InboxToolDeps): void {
  registry.register({
    name: 'jeeta.list_conversations',
    description: 'List conversations in the shared inbox, newest first. Read-only.',
    domain: 'inbox',
    scopes: ['contacts.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      status: z.string().optional().describe('Conversation status filter, e.g. "OPEN" or "CLOSED".'),
      channelId: z.string().optional().describe('Restrict results to one channel id.'),
      assignedToId: z.string().optional().describe('Restrict results to conversations assigned to this user id.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum conversations to return (default 50, capped at 100).'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      return deps.conversations.list(ctx.workspaceId, {
        status: typeof args.status === 'string' ? args.status : undefined,
        channelId: typeof args.channelId === 'string' ? args.channelId : undefined,
        assignedToId: typeof args.assignedToId === 'string' ? args.assignedToId : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
    },
  });

  registry.register({
    name: 'jeeta.read_conversation',
    description:
      'Read the full message history of one conversation by id, along with the linked lead and channel summary. Read-only.',
    domain: 'inbox',
    scopes: ['contacts.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      conversationId: z.string().min(1).describe('Conversation id to read.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      return deps.conversations.thread(ctx.workspaceId, String(args.conversationId ?? ''));
    },
  });

  registry.register({
    name: 'jeeta.send_message',
    description:
      'Send a reply in a conversation. This reaches a real customer, so in APPROVAL mode it is queued for a human instead of sending immediately.',
    domain: 'inbox',
    scopes: ['contacts.write'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'SEND',
    // Dedupe key for the broker's supersede sweep: a user re-asking, or a
    // transport retry, produces a second `jeeta.send_message` call for the
    // SAME conversation before the first is decided. Without this, both land
    // as separate PENDING cards and approving each sends the customer twice.
    resourceType: 'conversation',
    resourceIdFrom: (args) => (typeof args.conversationId === 'string' ? args.conversationId : undefined),
    inputSchema: z.object({
      conversationId: z.string().min(1).describe('Conversation id to reply in.'),
      body: z.string().min(1).describe('Message text to send to the customer.'),
    }),
    // Sent as AI-authored (see ConversationsService.replyAsAi) — an API-key
    // MCP session has no human user to attribute this to, and the message
    // genuinely was written by Claude, not a person.
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      return deps.conversations.replyAsAi(
        ctx.workspaceId,
        String(args.conversationId ?? ''),
        String(args.body ?? ''),
      );
    },
  });
}
