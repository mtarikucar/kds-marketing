import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { LeadAttributionService } from '../leads/lead-attribution.service';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { ConversationStreamService } from './conversation-stream.service';
import { ChannelType, InboundMessage } from './channel-adapter.interface';
import {
  normalizePhone,
  normalizeEmail,
  phoneIdentityVariants,
  localMsisdnVariants,
} from '../utils/lead-normalize';

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
/**
 * Stand-in name for a contact who arrived with none — a web-chat visitor, an
 * SMS from an unknown number.
 *
 * Exported because it is not just a display string: the AI's capture path fills
 * only EMPTY contact fields, so anything written here OCCUPIES the name slot.
 * Left as a bare literal, the customer's real name — asked for, given, and
 * passed to capture_lead_fields — was silently dropped, and the lead stayed
 * "Unknown" for good.
 */
export const PLACEHOLDER_CONTACT_NAME = 'Unknown';

@Injectable()
export class ConversationIngressService {
  private readonly logger = new Logger(ConversationIngressService.name);
  private readonly sentinelCache = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly autoAssigner: LeadAutoAssignerService,
    private readonly outbox: OutboxService,
    private readonly stream: ConversationStreamService,
    private readonly leadAttribution: LeadAttributionService,
  ) {}

  private async resolveSentinel(workspaceId: string): Promise<string | null> {
    const cached = this.sentinelCache.get(workspaceId);
    if (cached) return cached;
    const row = await this.prisma.marketingUser.findFirst({
      where: { workspaceId, role: 'SYSTEM' },
      select: { id: true },
    });
    const id = row?.id ?? null;
    // Cache only a RESOLVED id — never a miss. Caching null would permanently
    // (until process restart) disable the "new conversation" lead-activity note
    // for any workspace whose SYSTEM user didn't exist yet at its first inbound
    // message (a mid-provisioned/new workspace, or one backfilled later): every
    // later lookup would short-circuit on the stale null instead of re-checking.
    if (id) this.sentinelCache.set(workspaceId, id);
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
        // conversation id.
        //
        // That cross-tenant case is now unreachable: the unique is
        // (workspaceId, externalMessageId), so a foreign tenant's identical id
        // no longer blocks the insert. The scoping here stays as the backstop —
        // it is what makes this handler correct rather than merely lucky.
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
      // The funnel has just resolved (or created) this person; saying so is what
      // lets the agent surface refresh the one record on screen rather than
      // every record on screen, for every inbound anywhere in the workspace.
      leadId: result.leadId,
      payload: inbound.echo
        ? { id: result.messageId, direction: 'OUTBOUND', authorType: 'AGENT', body: inbound.text }
        : { id: result.messageId, direction: 'INBOUND', authorType: 'CUSTOMER', body: inbound.text },
    });
    return result;
  }

  /**
   * Resolve the sender's identity on this channel, across every spelling a
   * phone number might be stored under.
   *
   * An exact match on the provider's spelling was not enough. Each side of the
   * conversation normalizes differently — NetGSM inbound produces
   * "+905551112233", WhatsApp inbound the wa_id "905551112233", and outbound
   * threads were opened on whatever `normalizePhone` left behind ("05551112233")
   * — so a reply to a thread WE started matched nothing. The miss is invisible:
   * ingest simply creates a fresh "SMS contact / Unknown" lead and a second
   * conversation, the customer's answer never appears in the thread, and the CRM
   * gains a duplicate of a lead you already had.
   *
   * `addressFor` now writes canonical E.164, but rows written before that are
   * still in the old shapes, so this searches rather than assuming. Same
   * argument `localMsisdnVariants` makes for leads — it was simply never applied
   * to channel identities.
   */
  private async findIdentity(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    channelId: string,
    inbound: InboundMessage,
  ) {
    const exact = await tx.contactIdentity.findUnique({
      where: { channelId_value: { channelId, value: inbound.externalUserId } },
    });
    if (exact) return exact;

    if (inbound.kind !== 'PHONE' && inbound.kind !== 'WA') return null;
    const variants = phoneIdentityVariants(inbound.externalUserId).filter(
      (v) => v !== inbound.externalUserId,
    );
    if (!variants.length) return null;

    return tx.contactIdentity.findFirst({ where: { workspaceId, channelId, value: { in: variants } } });
  }

  /**
   * The lead this person ALREADY is, matched on the contact details rather than
   * on a channel identity — or null when they are genuinely new.
   *
   * `findIdentity` only ever asks "has this address written to THIS channel
   * before". When the answer is no, the caller used to create a lead, full
   * stop. That is right for a stranger and wrong for everyone else: a customer
   * entered by hand, imported from a spreadsheet, or captured by a website
   * form, who then replies to an email we sent them, has no identity on the
   * email channel — so the CRM quietly gained a second copy of them, the
   * outbound message sat on one record and their answer on the other, and the
   * person looking at either saw half a conversation.
   *
   * The dedup direction that DID exist is the mirror of this one: lead creation
   * here writes `emailNormalized`/`phoneNormalized` so a LATER form or import
   * matches the channel-born lead. This is the same rule pointing the other
   * way, and it is deliberately the same query the form, booking, import and
   * order-form paths use — including their two exclusions. A tombstoned
   * (`mergedIntoId`) lead must not be resurrected by a reply, and a
   * soft-deleted (`deletedAt`) one must not silently swallow a live
   * conversation into a record nobody can see.
   *
   * Only real contact keys qualify. PSID/IGSID/WEBCHAT/TIKTOKID/LINKEDIN are
   * opaque per-provider ids, not addresses: two of them being equal says
   * nothing about the human behind them, so those kinds fall through to
   * creation exactly as before.
   */
  private async findLeadByContact(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    inbound: InboundMessage,
  ): Promise<{ id: string; email: string | null; phone: string | null; whatsapp: string | null } | null> {
    const emailNormalized = inbound.kind === 'EMAIL' ? normalizeEmail(inbound.externalUserId) : null;
    const phoneNormalized =
      inbound.kind === 'PHONE' || inbound.kind === 'WA' ? normalizePhone(inbound.externalUserId) : null;
    if (!emailNormalized && !phoneNormalized) return null;

    return tx.lead.findFirst({
      where: {
        workspaceId,
        mergedIntoId: null,
        deletedAt: null,
        OR: [
          ...(emailNormalized ? [{ emailNormalized }] : []),
          // Every stored spelling of the number (0- / bare / 90- / +90 / 00-),
          // as İYS, telephony and leadgen do — an exact match would miss a lead
          // first stored in another format and duplicate it anyway.
          ...(phoneNormalized
            ? [{ phoneNormalized: { in: localMsisdnVariants(phoneNormalized) } }]
            : []),
        ],
      },
      select: { id: true, email: true, phone: true, whatsapp: true },
      // Oldest wins, so two ticks of the same inbound cannot adopt different
      // records, and the record chosen is the one the rest of the CRM's own
      // duplicate tooling calls canonical.
      orderBy: { createdAt: 'asc' },
    });
  }


  private async ingestInTx(
    tx: Prisma.TransactionClient,
    channel: IngressChannel,
    inbound: InboundMessage,
    sentinelId: string | null,
  ): Promise<IngressResult> {
    const workspaceId = channel.workspaceId;

    // 1. Resolve (or create) the contact identity → lead.
    let identity = await this.findIdentity(tx, workspaceId, channel.id, inbound);
    let createdNewLead = false;

    if (!identity) {
      const displayName = (inbound.displayName || '').trim();
      const isPhone = inbound.kind === 'PHONE' || inbound.kind === 'WA';
      // No identity on THIS channel does not mean no lead. The address may
      // already be in the CRM from a form, an import or a hand-entered record
      // — see findLeadByContact for why that used to duplicate.
      const existingLead = await this.findLeadByContact(tx, workspaceId, inbound);
      let leadId: string;

      if (existingLead) {
        leadId = existingLead.id;
        // Fill in the address we just learned, ONLY where the lead has none.
        // A lead entered by phone that now emails us should gain the email;
        // one that already carries a different address keeps it, because the
        // person on this channel is not authority over the other channel's
        // details.
        const fill: Record<string, string | null> = {};
        if (inbound.kind === 'EMAIL' && !existingLead.email) {
          fill.email = inbound.externalUserId;
          fill.emailNormalized = normalizeEmail(inbound.externalUserId);
        }
        if (isPhone && !existingLead.phone) {
          fill.phone = inbound.externalUserId;
          fill.phoneNormalized = normalizePhone(inbound.externalUserId);
        }
        if (inbound.kind === 'WA' && !existingLead.whatsapp) {
          fill.whatsapp = inbound.externalUserId;
        }
        if (Object.keys(fill).length > 0) {
          await tx.lead.updateMany({
            where: { id: leadId, workspaceId },
            data: fill as Prisma.LeadUpdateManyMutationInput,
          });
        }
      } else {
        createdNewLead = true;
        const autoOwner = await this.autoAssigner.pickAssignee(workspaceId, tx);
        const lead = await tx.lead.create({
          data: {
            workspaceId,
            businessName: displayName || `${this.label(channel.type)} contact`,
            contactPerson: displayName || PLACEHOLDER_CONTACT_NAME,
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
        leadId = lead.id;
      }

      identity = await tx.contactIdentity.create({
        data: {
          workspaceId,
          channelId: channel.id,
          kind: inbound.kind,
          value: inbound.externalUserId,
          leadId,
        },
      });
      // First-touch attribution (D10b): a CTWA/CTM ad referral on the FIRST
      // message ties this conversation-born lead to the sourcing ad. Only an
      // ad-typed referral maps its source id; capture() is best-effort and
      // first-touch-idempotent, enrolled in this tx. It runs for an ADOPTED
      // lead too — the referral is just as real when the person was already in
      // the CRM, and idempotency makes a second capture a no-op.
      if (inbound.referral) {
        const r = inbound.referral;
        const isAd = /^ads?$/i.test(String(r.sourceType ?? ''));
        await this.leadAttribution.capture(
          workspaceId,
          leadId,
          {
            ...(r.ctwaClid ? { ctwaClid: r.ctwaClid } : {}),
            ...(r.sourceUrl ? { url: r.sourceUrl } : {}),
          },
          isAd && r.sourceId ? { sourceAdCampaignId: r.sourceId } : {},
          tx,
        );
      }
      if (sentinelId) {
        await tx.leadActivity.create({
          data: {
            leadId,
            type: 'NOTE',
            // An echo means the owner messaged this person first, from the
            // provider's own app. Same note, honest about who spoke — the
            // description below is OUR text in that case, not theirs.
            title: inbound.echo
              ? `New ${this.label(channel.type)} conversation (you messaged first)`
              : `New ${this.label(channel.type)} conversation`,
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

    // 3. Persist the message (externalMessageId unique = dedup backstop).
    // An echo is the account's OWN message seen on the webhook — the owner
    // replying from the Instagram/Messenger app. It belongs in the thread as
    // what it is: outbound, from the team, already sent.
    const message = await tx.message.create({
      data: {
        workspaceId,
        conversationId: convo.id,
        direction: inbound.echo ? 'OUTBOUND' : 'INBOUND',
        authorType: inbound.echo ? 'AGENT' : 'CUSTOMER',
        body: inbound.text,
        externalMessageId: inbound.externalMessageId,
        status: inbound.echo ? 'SENT' : 'RECEIVED',
        meta: inbound.raw ? ({ raw: inbound.raw } as Prisma.InputJsonValue) : undefined,
      },
    });

    // 4. Bump conversation view + recency state.
    // An echo bumps recency ONLY. It is not unread — the owner wrote it — and
    // it is not inbound: `lastInboundAt` is what the provider's 24-hour reply
    // window is measured from, so stamping it here would show a window this
    // account does not actually have, and a send inside it fails at Meta.
    await tx.conversation.update({
      where: { id: convo.id },
      data: inbound.echo
        ? { lastMessageAt: new Date() }
        : {
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
    // NOT for an echo. This event is what the AI engine replies to, so emitting
    // it here would have the assistant answer its own owner — and, because each
    // reply is itself echoed back, do it again on the next webhook.
    if (!inbound.echo) {
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
    }

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
