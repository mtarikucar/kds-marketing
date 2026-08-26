import { z } from 'zod';
import { OutboundConversationService } from '../../channels/outbound-conversation.service';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { ConversationsService } from '../../channels/conversations.service';
import { ChannelsService } from '../../channels/channels.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface InboxToolDeps {
  outbound: OutboundConversationService;
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
    name: 'jeeta.message_lead',
    description:
      'Start a conversation with a lead you choose, on SMS, WhatsApp or email — the outbound counterpart to jeeta.send_message, which can only reply to a thread the customer already opened. Reuses the open thread if there is one. Instagram, Messenger and TikTok are NOT available here: those platforms only permit replying to someone who messaged you first. WhatsApp outside the 24h window needs an approved template.',
    domain: 'inbox',
    // Deferred: reaching out to one named lead is a deliberate act, not part
    // of the default inbox surface.
    defer: true,
    scopes: ['contacts.write'],
    risk: 'WRITE',
    // Reaches a real person who did not write to us first, so it is gated
    // exactly like send_message.
    requiresApproval: true,
    approvalKind: 'SEND',
    resourceType: 'lead',
    resourceIdFrom: (args) => (typeof args.leadId === 'string' ? args.leadId : undefined),
    inputSchema: z.object({
      leadId: z.string().min(1).describe('Id of the lead to reach.'),
      channelId: z
        .string()
        .min(1)
        .describe('Id of the connected channel to send on (SMS, WhatsApp or email).'),
      text: z.string().max(4000).optional().describe('Message body.'),
      template: z
        .object({
          name: z.string().min(1).max(200),
          languageCode: z.string().min(2).max(10),
          components: z.array(z.unknown()).optional(),
        })
        .optional()
        .describe('Approved WhatsApp template, required outside the 24h session window.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      return deps.outbound.start(ctx.workspaceId, {
        leadId: String(args.leadId),
        channelId: String(args.channelId),
        text: typeof args.text === 'string' ? args.text : undefined,
        template: args.template as never,
      });
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

  registry.register({
    name: 'jeeta.list_channels',
    description:
      'List every messaging channel this workspace has — type, name, status, and which provider identity ' +
      'it is bound to. This is how you find out what the inbox can actually send and receive on before ' +
      'promising a customer anything. Secrets are never returned; `configuredSecrets` only names which ' +
      'credential fields are set.',
    domain: 'inbox',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => deps.channels.list(ctx.workspaceId),
  });

  registry.register({
    name: 'jeeta.set_channel_status',
    description:
      'Enable or disable a channel. DISABLED silences the channel in BOTH directions — inbound webhooks ' +
      'stop resolving to it and outbound sends are refused — so use it to take a channel out of service, ' +
      'not to pause a campaign. Reversible: set it back to ACTIVE to resume.',
    domain: 'inbox',
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    // Same authority the panel's channel settings already give a MANAGER, so
    // no extra gate — but the description spells out the inbound consequence,
    // because "disabled" reads like a pause and is not one.
    requiresApproval: false,
    inputSchema: z.object({
      channelId: z.string().min(1).describe('Channel id, from jeeta.list_channels.'),
      status: z
        .enum(['ACTIVE', 'DISABLED'])
        .describe('ACTIVE puts the channel back in service; DISABLED takes it out.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'conversationAi');
      return deps.channels.update(ctx.workspaceId, String(args.channelId), {
        status: args.status as string,
      } as never);
    },
  });

  /**
   * "Can this channel actually receive?"
   *
   * The check existed and nothing could reach it. Verify was a button on a
   * panel screen, so the one question that matters about an inbox — is anyone
   * actually going to hear a customer who writes in — could not be asked from
   * anywhere else, including by whoever is trying to work out why the inbox has
   * been quiet.
   *
   * That question got sharper teeth in the same change that added this tool:
   * healthCheck used to call GET /me and stop, which proves the token is alive
   * and says nothing about whether the app is subscribed to the Page's
   * `messages` webhook. Those are independent, and a channel with a good token
   * and no subscription is deaf while looking perfectly healthy.
   *
   * READ: it sends nothing, publishes nothing, and changes nothing about what
   * the channel does. It runs one live probe against the provider and, on
   * success only, stamps lastVerifiedAt — a diagnostic, not an act.
   */
  registry.register({
    name: 'jeeta.verify_channel',
    description:
      'Run a live health check against a channel and report whether it can actually send AND receive. ' +
      "For Messenger and Instagram this also asks Meta whether the app is subscribed to the Page's " +
      '`messages` webhook — a valid token alone does not mean inbound messages arrive. Use it when an ' +
      'inbox has gone quiet, before concluding that nobody has written. Read-only: nothing is sent or ' +
      'published.',
    domain: 'inbox',
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      channelId: z.string().min(1).describe('Channel id, from jeeta.list_channels.'),
    }),
    handler: async (ctx, args) => deps.channels.verify(ctx.workspaceId, String(args.channelId)),
  });
}
