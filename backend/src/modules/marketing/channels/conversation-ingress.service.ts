import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { ConversationStreamService } from './conversation-stream.service';
import { ChannelType, InboundMessage } from './channel-adapter.interface';
import { normalizePhone, normalizeEmail } from '../utils/lead-normalize';

export interface IngressChannel {
  id: string;
  workspaceId: string;
  type: string;
}

export interface IngressResult {
  conversationId: string;
  messageId: string;
  leadId: string;
  isNewConversation: boolean;
  deduped: boolean;
}

/** Lead.source value for a first-touch on each channel type. */
const SOURCE_BY_CHANNEL: Record<string, string> = {
  WEBCHAT: 'WEBSITE',
  WHATSAPP: 'OTHER',
  SMS: 'PHONE',
  INSTAGRAM: 'INSTAGRAM',
  MESSENGER: 'OTHER',
  LINKEDIN: 'OTHER',
};

/**
 * The inbound funnel — the ONE path every channel's inbound message flows
 * through. Resolves the channel identity to a Lead (find-or-create + auto-
 * assign, mirroring the research-ingest pattern), finds/opens the conversation,
 * persists the inbound Message, bumps counters, and emits
 * ConversationMessageReceived so the AI engine + workflow triggers fire.
 *
 * Idempotent on the provider's externalMessageId: a redelivered webhook
 * resolves to the existing message (the @unique index is the backstop against
 * a concurrent double-delivery, caught as P2002 → deduped).
 */
@Injectable()
export class ConversationIngressService {
  private readonly logger = new Logger(ConversationIngressService.name);
  private readonly sentinelCache = new Map<string, string | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly autoAssigner: LeadAutoAssignerService,
    private readonly outbox: OutboxService,
    private readonly stream: ConversationStreamService,
  ) {}

  private async resolveSentinel(workspaceId: string): Promise<string | null> {
    if (this.sentinelCache.has(workspaceId)) return this.sentinelCache.get(workspaceId)!;
    const row = await this.prisma.marketingUser.findFirst({
      where: { workspaceId, role: 'SYSTEM' },
      select: { id: true },
    });
    const id = row?.id ?? null;
    this.sentinelCache.set(workspaceId, id);
    return id;
  }

  async ingest(channel: IngressChannel, inbound: InboundMessage): Promise<IngressResult | null> {
    const workspaceId = channel.workspaceId;

    // Cap oversize inbound text once, for ALL channels, BEFORE dedup/persist/emit
    // so a hostile provider can't blow up storage or downstream prompts.
    const MAX_INBOUND_CHARS = 8000;
    if (inbound.text && inbound.text.length > MAX_INBOUND_CHARS) {
      inbound = { ...inbound, text: inbound.text.slice(0, MAX_INBOUND_CHARS) };
    }

    // Fast-path dedup: a redelivered message resolves to the existing row.
    // MUST be workspace-scoped — `externalMessageId` is globally unique in the
    // schema, but provider message ids are only unique per business/page/account,
    // so a cross-tenant id collision would otherwise drop another tenant's message
    // and hand back a foreign conversation id. A foreign hit → fall through.
    if (inbound.externalMessageId) {
      const existing = await this.prisma.message.findFirst({
        where: { externalMessageId: inbound.externalMessageId, workspaceId },
        select: { id: true, conversationId: true },
      });
      if (existing) {
        const convo = await this.prisma.conversation.findFirst({
          where: { id: existing.conversationId, workspaceId },
          select: { leadId: true },
        });
        return {
          conversationId: existing.conversationId,
          messageId: existing.id,
          leadId: convo?.leadId ?? '',
          isNewConversation: false,
          deduped: true,
        };
      }
    }

    const sentinelId = await this.resolveSentinel(workspaceId);

    let result: IngressResult;
    try {
      result = await this.prisma.$transaction((tx) =>
        this.ingestInTx(tx, channel, inbound, sentinelId),
      );
    } catch (e: any) {
      // Concurrent double-delivery lost the race on the externalMessageId unique
      // index — re-resolve and report deduped rather than erroring the webhook.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && inbound.externalMessageId) {
        // Re-resolve workspace-scoped: only a SAME-workspace concurrent
        // double-delivery is a real dedup. A cross-tenant id collision finds
        // nothing here and re-throws (fail-closed) rather than leaking a foreign
        // conversation id. (A composite (workspaceId, externalMessageId) unique
        // would let the insert itself succeed — tracked as a follow-up.)
        const existing = await this.prisma.message.findFirst({
          where: { externalMessageId: inbound.externalMessageId, workspaceId },
          select: { id: true, conversationId: true },
        });
        if (existing) {
          return {
            conversationId: existing.conversationId,
            messageId: existing.id,
            leadId: '',
            isNewConversation: false,
            deduped: true,
          };
        }
      }
      throw e;
    }

    // Live fan-out to the Inbox (outside the tx so subscribers see committed rows).
    this.stream.push(workspaceId, {
      kind: 'message',
      conversationId: result.conversationId,
      payload: { id: result.messageId, direction: 'INBOUND', authorType: 'CUSTOMER', body: inbound.text },
    });
    return result;
  }

  private async ingestInTx(
    tx: Prisma.TransactionClient,
    channel: IngressChannel,
    inbound: InboundMessage,
    sentinelId: string | null,
  ): Promise<IngressResult> {
    const workspaceId = channel.workspaceId;

    // 1. Resolve (or create) the contact identity → lead.
    let identity = await tx.contactIdentity.findUnique({
      where: { channelId_value: { channelId: channel.id, value: inbound.externalUserId } },
    });
    const createdNewLead = !identity;

    if (!identity) {
      const autoOwner = await this.autoAssigner.pickAssignee(workspaceId, tx);
      const displayName = (inbound.displayName || '').trim();
      const isPhone = inbound.kind === 'PHONE' || inbound.kind === 'WA';
      const lead = await tx.lead.create({
        data: {
          workspaceId,
          businessName: displayName || `${this.label(channel.type)} contact`,
          contactPerson: displayName || 'Unknown',
          businessType: 'OTHER',
          source: SOURCE_BY_CHANNEL[channel.type] ?? 'OTHER',
          status: 'NEW',
          // Write the normalized phone too so a later form/manual lead with the
          // same number dedup-matches this channel-created lead (cross-path).
          ...(isPhone
            ? { phone: inbound.externalUserId, phoneNormalized: normalizePhone(inbound.externalUserId) }
            : {}),
          ...(inbound.kind === 'WA' ? { whatsapp: inbound.externalUserId } : {}),
          // Email leads get their address written (+ normalized) so a later
          // form/manual lead with the same email dedup-matches this one.
          ...(inbound.kind === 'EMAIL'
            ? { email: inbound.externalUserId, emailNormalized: normalizeEmail(inbound.externalUserId) }
            : {}),
          ...(autoOwner ? { assignedToId: autoOwner } : {}),
        },
      });
      identity = await tx.contactIdentity.create({
        data: {
          workspaceId,
          channelId: channel.id,
          kind: inbound.kind,
          value: inbound.externalUserId,
          leadId: lead.id,
        },
      });
      if (sentinelId) {
        await tx.leadActivity.create({
          data: {
            leadId: lead.id,
            type: 'NOTE',
            title: `New ${this.label(channel.type)} conversation`,
            description: inbound.text.slice(0, 500),
            createdById: sentinelId,
          },
        });
      }
    }

    // 2. Find the open conversation for this identity, or open one.
    let convo = await tx.conversation.findFirst({
      where: {
        workspaceId,
        channelId: channel.id,
        contactIdentityId: identity.id,
        status: 'OPEN',
      },
      orderBy: { createdAt: 'desc' },
    });
    const isNewConversation = !convo;
    if (!convo) {
      convo = await tx.conversation.create({
        data: {
          workspaceId,
          channelId: channel.id,
          leadId: identity.leadId,
          contactIdentityId: identity.id,
          status: 'OPEN',
        },
      });
    }

    // 3. Persist the inbound message (externalMessageId unique = dedup backstop).
    const message = await tx.message.create({
      data: {
        workspaceId,
        conversationId: convo.id,
        direction: 'INBOUND',
        authorType: 'CUSTOMER',
        body: inbound.text,
        externalMessageId: inbound.externalMessageId,
        status: 'RECEIVED',
        meta: inbound.raw ? ({ raw: inbound.raw } as Prisma.InputJsonValue) : undefined,
      },
    });

    // 4. Bump conversation view + recency state.
    await tx.conversation.update({
      where: { id: convo.id },
      data: {
        unreadCount: { increment: 1 },
        lastMessageAt: new Date(),
        lastInboundAt: new Date(),
      },
    });

    // 5. Emit domain events in the same tx (fire only on commit).
    const occurredAt = new Date().toISOString();
    if (createdNewLead) {
      // A first-touch from a channel is a new lead → workflow trigger source.
      await this.outbox.append(
        {
          type: MarketingEventTypes.LeadCreated,
          idempotencyKey: `lead-created:${identity.leadId}`,
          payload: {
            workspaceId,
            leadId: identity.leadId,
            source: SOURCE_BY_CHANNEL[channel.type] ?? 'OTHER',
            channelType: channel.type,
            occurredAt,
          },
        },
        tx as any,
      );
    }
    if (isNewConversation) {
      await this.outbox.append(
        {
          type: MarketingEventTypes.ConversationStarted,
          idempotencyKey: `conv-started:${convo.id}`,
          payload: {
            workspaceId,
            conversationId: convo.id,
            channelId: channel.id,
            channelType: channel.type,
            leadId: identity.leadId,
            occurredAt,
          },
        },
        tx as any,
      );
    }
    await this.outbox.append(
      {
        type: MarketingEventTypes.ConversationMessageReceived,
        idempotencyKey: `conv-msg:${message.id}`,
        payload: {
          workspaceId,
          conversationId: convo.id,
          channelId: channel.id,
          channelType: channel.type,
          leadId: identity.leadId,
          messageId: message.id,
          text: inbound.text,
          occurredAt,
        },
      },
      tx as any,
    );

    return {
      conversationId: convo.id,
      messageId: message.id,
      leadId: identity.leadId,
      isNewConversation,
      deduped: false,
    };
  }

  private label(type: string): string {
    const t = type as ChannelType;
    switch (t) {
      case 'WEBCHAT':
        return 'Web chat';
      case 'WHATSAPP':
        return 'WhatsApp';
      case 'SMS':
        return 'SMS';
      case 'INSTAGRAM':
        return 'Instagram';
      case 'MESSENGER':
        return 'Messenger';
      case 'LINKEDIN':
        return 'LinkedIn';
      default:
        return 'Channel';
    }
  }
}
