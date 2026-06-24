import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { MessageQuotaService } from './message-quota.service';
import { ConversationStreamService } from './conversation-stream.service';
import { OutboundMedia, OutboundTemplate } from './channel-adapter.interface';

export interface SendMessageInput {
  workspaceId: string;
  conversationId: string;
  text: string;
  /** AI = engine reply, AGENT = human reply, SYSTEM = workflow/campaign send. */
  authorType: 'AI' | 'AGENT' | 'SYSTEM';
  /** MarketingUser id for AGENT sends; null for AI/SYSTEM. */
  authorId?: string | null;
  /** Optional richer payloads forwarded to the adapter (WhatsApp template /
   *  by-URL media). Text-only callers are unaffected. */
  template?: OutboundTemplate;
  media?: OutboundMedia;
}

/**
 * Outbound send pipeline: reserve message quota → resolve channel config →
 * adapter.send → persist the Message → bump the conversation → emit
 * MessageSent + push it over SSE. Quota is refunded if the adapter reports
 * FAILED, and a failed send is still persisted (status=FAILED) so the agent
 * sees it in the thread. The adapter contract is "never throw on provider
 * errors", but we defend against it anyway.
 */
@Injectable()
export class MessageSenderService {
  private readonly logger = new Logger(MessageSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly quota: MessageQuotaService,
    private readonly outbox: OutboxService,
    private readonly stream: ConversationStreamService,
  ) {}

  async send(input: SendMessageInput) {
    const { workspaceId, conversationId, text, authorType } = input;
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
    });
    if (!convo) throw new NotFoundException('Conversation not found');
    const channel = await this.prisma.channel.findFirst({
      where: { id: convo.channelId, workspaceId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const identity = convo.contactIdentityId
      ? await this.prisma.contactIdentity.findFirst({
          where: { id: convo.contactIdentityId, workspaceId },
        })
      : null;
    const to = identity?.value ?? null;

    // Reserve BEFORE the send (skips web-chat). Throws MESSAGES_EXHAUSTED at cap.
    await this.quota.reserve(workspaceId, channel.type);

    let result: { externalMessageId: string | null; status: 'SENT' | 'FAILED'; error?: string };
    try {
      const adapter = this.registry.get(channel.type);
      const config = this.registry.resolveConfig(channel);
      result = to
        ? await adapter.send({ config, to, text, template: input.template, media: input.media })
        : { externalMessageId: null, status: 'FAILED', error: 'no recipient identity on conversation' };
    } catch (e: any) {
      result = { externalMessageId: null, status: 'FAILED', error: e?.message ?? String(e) };
    }

    let refunded = false;
    if (result.status === 'FAILED') {
      await this.quota.refund(workspaceId, channel.type);
      refunded = true;
      const scrubbed = String(result.error ?? '').replace(/password=[^&\s]+/gi, 'password=***');
      this.logger.warn(`send failed convo=${conversationId} ch=${channel.type}: ${scrubbed}`);
    }

    // Persist the message, bump the conversation, and enqueue the domain event
    // in ONE transaction: the outbox is durable only when appended in the same
    // tx as the state change, and a crash mid-way must not leave a sent message
    // unrecorded with its event lost.
    let message;
    try {
      message = await this.prisma.$transaction(async (tx) => {
        const m = await tx.message.create({
          data: {
            workspaceId,
            conversationId,
            direction: 'OUTBOUND',
            authorType,
            authorId: input.authorId ?? null,
            body: text,
            externalMessageId: result.externalMessageId,
            status: result.status,
            error: result.error ?? null,
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: new Date() },
        });
        await this.outbox.append(
          {
            type: MarketingEventTypes.ConversationMessageSent,
            idempotencyKey: `conv-msg-sent:${m.id}`,
            payload: {
              workspaceId,
              conversationId,
              channelId: channel.id,
              messageId: m.id,
              authorType,
              occurredAt: new Date().toISOString(),
            },
          },
          tx as any,
        );
        return m;
      });
    } catch (e) {
      // A successful provider send whose bookkeeping failed must NOT permanently
      // consume the customer's monthly message quota — refund what we reserved
      // (unless the send already FAILED and was refunded above), then surface it.
      if (!refunded) await this.quota.refund(workspaceId, channel.type);
      throw e;
    }

    // Best-effort live fan-out, only after the tx has committed.
    this.stream.push(workspaceId, { kind: 'message', conversationId, payload: message });
    return message;
  }
}
