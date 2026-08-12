import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { ConversationsService } from '../../channels/conversations.service';
import { ChannelsService } from '../../channels/channels.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface InboxToolDeps {
  conversations: ConversationsService;
  channels: ChannelsService;
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

/**
 * Channel provisioning, restricted to the one type that needs no credentials.
 *
 * The inbox tools could read and reply to conversations — but nothing in the
 * catalogue could CREATE the channel those conversations arrive on, so a
 * workspace with no channel had a permanently empty inbox and no agent-reply
 * surface, and an agent had no way to change that. Every other channel type
 * (WhatsApp/SMS/Instagram/Messenger/TikTok) genuinely requires provider
 * credentials or an OAuth handshake and stays a panel job; WEBCHAT needs
 * neither — `ChannelsService.create` mints its own widgetKey and the channel is
 * ACTIVE immediately — so it is the one an agent can legitimately stand up.
 *
 * Deliberately narrow: type is not a parameter. Accepting one would invite
 * secrets over the tool surface, and the credentialed types have their own
 * validated flows (Embedded Signup, OAuth) that this must not shadow.
 */
export function registerChannelWriteTools(registry: McpToolRegistry, deps: InboxToolDeps): void {
  registry.register({
    name: 'jeeta.create_webchat_channel',
    description:
      'Create a WEB CHAT channel for this workspace — the website chat widget. It needs no credentials and ' +
      'goes live immediately with its own widget key, so this is how a workspace with an empty inbox starts ' +
      'receiving conversations. Optionally attach an AI agent profile to answer on it. Other channel types ' +
      '(WhatsApp, SMS, Instagram, Messenger, TikTok) need provider credentials and are connected in the panel.',
    domain: 'inbox',
    // Deferred: a once-per-workspace setup call, which is exactly what the
    // defer flag is for — and since jeeta.call_tool shipped, deferred tools are
    // genuinely reachable rather than merely catalogued. Keeps the advertised
    // surface at its ceiling without costing a per-turn tool its slot.
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(120)
        .describe('Display name for the channel, e.g. "Site sohbeti".'),
      agentProfileId: z
        .string()
        .max(64)
        .optional()
        .describe('AI agent profile that should answer on this channel (see the Agent Studio). Optional.'),
    }),
    handler: async (ctx, args) => {
      // Same package boundary the REST channel routes enforce — without it the
      // inbox could be switched on over MCP for a plan that excludes it.
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      return deps.channels.create(ctx.workspaceId, {
        type: 'WEBCHAT',
        name: String(args.name ?? '').trim(),
        agentProfileId: typeof args.agentProfileId === 'string' ? args.agentProfileId : undefined,
      } as never);
    },
  });
}
