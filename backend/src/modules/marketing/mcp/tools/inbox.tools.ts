import { z } from 'zod';
import { ConversationsService } from '../../channels/conversations.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface InboxToolDeps {
  conversations: ConversationsService;
}

/**
 * Shared-inbox tools: two ungated reads (list/read a conversation) and one
 * approval-gated write (send a reply). `jeeta.send_message` reaches a real
 * customer, so it is registered `requiresApproval: true` — the broker
 * (`mcp-broker.service.ts`) enqueues a human approval instead of ever running
 * this handler inline unless the workspace's writeMode is AUTONOMOUS.
 */
export function registerInboxTools(registry: McpToolRegistry, deps: InboxToolDeps): void {
  registry.register({
    name: 'jeeta.list_conversations',
    description: 'List conversations in the shared inbox, newest first. Read-only.',
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
    handler: async (ctx, args) =>
      deps.conversations.list(ctx.workspaceId, {
        status: typeof args.status === 'string' ? args.status : undefined,
        channelId: typeof args.channelId === 'string' ? args.channelId : undefined,
        assignedToId: typeof args.assignedToId === 'string' ? args.assignedToId : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      }),
  });

  registry.register({
    name: 'jeeta.read_conversation',
    description:
      'Read the full message history of one conversation by id, along with the linked lead and channel summary. Read-only.',
    scopes: ['contacts.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      conversationId: z.string().min(1).describe('Conversation id to read.'),
    }),
    handler: async (ctx, args) => deps.conversations.thread(ctx.workspaceId, String(args.conversationId ?? '')),
  });

  registry.register({
    name: 'jeeta.send_message',
    description:
      'Send a reply in a conversation. This reaches a real customer, so in APPROVAL mode it is queued for a human instead of sending immediately.',
    scopes: ['contacts.write'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'SEND',
    inputSchema: z.object({
      conversationId: z.string().min(1).describe('Conversation id to reply in.'),
      body: z.string().min(1).describe('Message text to send to the customer.'),
    }),
    // Sent as AI-authored (see ConversationsService.replyAsAi) — an API-key
    // MCP session has no human user to attribute this to, and the message
    // genuinely was written by Claude, not a person.
    handler: async (ctx, args) =>
      deps.conversations.replyAsAi(ctx.workspaceId, String(args.conversationId ?? ''), String(args.body ?? '')),
  });
}
