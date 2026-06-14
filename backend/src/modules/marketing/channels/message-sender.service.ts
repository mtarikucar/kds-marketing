import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { MessageQuotaService } from './message-quota.service';
import { ConversationStreamService } from './conversation-stream.service';

export interface SendMessageInput {
  workspaceId: string;
  conversationId: string;
  text: string;
  /** AI = engine reply, AGENT = human reply, SYSTEM = workflow/campaign send. */
  authorType: 'AI' | 'AGENT' | 'SYSTEM';
  /** MarketingUser id for AGENT sends; null for AI/SYSTEM. */
  authorId?: string | null;
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
        ? await adapter.send({ config, to, text })
        : { externalMessageId: null, status: 'FAILED', error: 'no recipient identity on conversation' };
    } catch (e: any) {
      result = { externalMessageId: null, status: 'FAILED', error: e?.message ?? String(e) };
    }

    if (result.status === 'FAILED') {
      await this.quota.refund(workspaceId, channel.type);
      const scrubbed = String(result.error ?? '').replace(/password=[^&\s]+/gi, 'password=***');
      this.logger.warn(`send failed convo=${conversationId} ch=${channel.type}: ${scrubbed}`);
    }

    const message = await this.prisma.message.create({
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

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    await this.outbox.append({
      type: MarketingEventTypes.ConversationMessageSent,
      idempotencyKey: `conv-msg-sent:${message.id}`,
      payload: {
        workspaceId,
        conversationId,
        channelId: channel.id,
        messageId: message.id,
        authorType,
        occurredAt: new Date().toISOString(),
      },
    });

    this.stream.push(workspaceId, { kind: 'message', conversationId, payload: message });
    return message;
  }
}
