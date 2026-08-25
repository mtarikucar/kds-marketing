import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { MessageQuotaService } from './message-quota.service';
import { ConversationStreamService } from './conversation-stream.service';
import { OutboundMedia, OutboundTemplate } from './channel-adapter.interface';
import { ConversationSpendService } from '../budget/conversation-spend.service';

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
    private readonly conversationSpend: ConversationSpendService,
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
    // Disabling a channel silenced its INBOUND immediately — byExternalId only
    // resolves ACTIVE rows — but left outbound working, so a disabled channel
    // kept sending and kept burning message quota (reserve() is below) while
    // nothing could come back. OutboundConversationService already refuses to
    // OPEN a thread on a non-ACTIVE channel; replying on one was the gap.
    // Same null-tolerance as there: fixtures and older rows carry no status.
    if (channel.status && channel.status !== 'ACTIVE') {
      throw new BadRequestException(`Channel is ${channel.status}, not ACTIVE`);
    }

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
            // What actually went out. The WhatsApp adapter's precedence is
            // template > media > text, and the template is rendered by Meta
            // from a name + language, not by us — so persisting `text` for a
            // template send stored something the customer never received:
            // empty for a template-only send, and the ignored text when both
            // were passed. A rep opening the thread saw a blank outbound
            // message, or worse, copy that was never sent.
            body: input.template ? templateBody(input.template, text) : text,
            // The template identity itself, so the summary above stays
            // human-facing and the raw truth is still queryable.
            meta: input.template
              ? ({
                  template: {
                    name: input.template.name,
                    languageCode: input.template.languageCode,
                  },
                } as Prisma.InputJsonValue)
              : undefined,
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

    // Price + debit the per-segment SMS cost against the growth budget. Best-
    // effort and fire-and-forget: ConversationSpendService.settleSms never
    // throws (its internal errors are caught and logged), but the `.catch`
    // here is a defensive backstop — a billing hiccup must NEVER fail (or even
    // delay) a send that already reached the customer.
    if (channel.type === 'SMS' && result.status === 'SENT') {
      this.conversationSpend
        .settleSms(workspaceId, { messageId: message.id, text })
        .catch((err) =>
          this.logger.warn(`SMS settlement failed for message ${message.id}: ${String((err as Error)?.message ?? err)}`),
        );
    }

    return message;
  }
}

/**
 * A readable stand-in for a template send.
 *
 * Meta renders an approved template from a name + language + parameters; the
 * rendered text never exists on our side, so there is nothing truthful to store
 * as the body. This records WHAT was sent rather than pretending to quote it,
 * and keeps any caller-supplied text as context — that text is not what the
 * customer received (the adapter's precedence is template > media > text), so
 * it is labelled rather than presented as the message.
 */
function templateBody(template: OutboundTemplate, text: string): string {
  const head = `[template: ${template.name} (${template.languageCode})]`;
  const note = text.trim();
  return note ? `${head} ${note}` : head;
}
