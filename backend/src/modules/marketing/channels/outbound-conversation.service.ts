import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MessageSenderService } from './message-sender.service';
import { ChannelType, ContactKind, OutboundTemplate } from './channel-adapter.interface';
import { normalizeEmail, phoneIdentityVariants, toE164 } from '../utils/lead-normalize';

/**
 * Which channels a conversation can be STARTED on, and what address each needs.
 *
 * This list is short because the platforms make it short, not because the
 * adapters are missing. Instagram, Messenger and TikTok only permit a reply to
 * someone who messaged you first, inside the window their API enforces — there
 * is no endpoint that DMs an arbitrary user, so "message this lead on
 * Instagram" cannot be built, only faked. LinkedIn here is engagement
 * (comments on our own posts), not messaging. Webchat identities are browser
 * visitors who only exist once they open the widget, and Voice is inbound.
 *
 * So an outbound-first conversation means SMS, WhatsApp or email: the three
 * where we hold an address the lead gave us and the platform allows the first
 * move.
 */
const INITIABLE: Record<
  string,
  { kind: ContactKind; label: string; supportsTemplate: boolean }
> = {
  SMS: { kind: 'PHONE', label: 'phone number', supportsTemplate: false },
  WHATSAPP: { kind: 'WA', label: 'WhatsApp number', supportsTemplate: true },
  EMAIL: { kind: 'EMAIL', label: 'email address', supportsTemplate: false },
};

/** Why each excluded channel is excluded, so the refusal can say something useful. */
const NOT_INITIABLE: Record<string, string> = {
  INSTAGRAM:
    'Instagram only allows replying to someone who messaged you first — there is no API to DM an arbitrary user.',
  MESSENGER:
    'Messenger only allows replying inside the window opened by the person messaging you first.',
  TIKTOK: 'TikTok Business Messaging only allows replying to an inbound message.',
  LINKEDIN: 'The LinkedIn channel handles engagement on your own posts, not direct messages.',
  WEBCHAT: 'A webchat identity only exists once the visitor opens the widget on your site.',
  VOICE: 'The voice channel answers inbound calls; use a call task to reach out by phone.',
};

export interface StartConversationInput {
  leadId: string;
  channelId: string;
  text?: string;
  /** Required on WhatsApp outside the 24h session window. */
  template?: OutboundTemplate;
}

/**
 * Starting a conversation with a lead we chose, rather than waiting to be
 * messaged.
 *
 * Everything in the inbox until now began at ConversationIngressService: a
 * customer wrote in, and a lead was born from their identity. The reverse —
 * "message this lead" — had no path at all, in the product or over MCP;
 * `jeeta.send_message` requires a conversationId that can only exist if the
 * customer moved first. Campaigns could reach a list, but nothing could open a
 * single thread with one person.
 *
 * This is that inverse: resolve the lead's address for a channel, find or open
 * the thread, and hand off to MessageSenderService — which already owns quota,
 * the adapter call, the Message row and spend settlement, so none of that is
 * duplicated here.
 */
@Injectable()
export class OutboundConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: MessageSenderService,
  ) {}

  /**
   * The lead's address for this channel, in the CANONICAL form ingress writes.
   *
   * This used to call `normalizePhone` — a lead MATCH KEY that keeps whatever
   * shape the number arrived in — while NetGSM inbound writes E.164. So a
   * thread started here on "05551112233" could never be matched by the reply
   * arriving as "+905551112233": ingress found no identity and forked the
   * customer into a second "SMS contact / Unknown" lead, leaving the thread you
   * opened looking unanswered forever. "05551112233" is also not a valid `to`
   * for the WhatsApp Cloud API, which the adapter forwards verbatim.
   */
  private addressFor(
    type: ChannelType,
    lead: { phone: string | null; whatsapp: string | null; email: string | null },
  ): string | null {
    if (type === 'EMAIL') return lead.email ? normalizeEmail(lead.email) : null;
    // WhatsApp falls back to the plain phone: a lead captured by phone is
    // reachable on WhatsApp at the same number far more often than not, and
    // refusing when `whatsapp` happens to be blank would be pedantic.
    const raw = type === 'WHATSAPP' ? (lead.whatsapp ?? lead.phone) : lead.phone;
    return raw ? toE164(raw) : null;
  }

  /** Mirrors ConversationAiEngineService's check — same flags, same mapping, so
   *  the two paths that reach a lead cannot drift apart on who is contactable. */
  private hasOptedOut(
    type: ChannelType,
    lead: { emailOptOut?: boolean | null; smsOptOut?: boolean | null; waOptOut?: boolean | null },
  ): boolean {
    if (type === 'EMAIL') return !!lead.emailOptOut;
    if (type === 'SMS') return !!lead.smsOptOut;
    if (type === 'WHATSAPP') return !!lead.waOptOut;
    return false;
  }

  /** Every stored spelling this address could already be on file as: a phone
   *  has several (see phoneIdentityVariants), an email exactly one. */
  private candidateValues(type: ChannelType, address: string): string[] {
    if (type === 'EMAIL') return [address];
    const variants = phoneIdentityVariants(address);
    return variants.length ? variants : [address];
  }

  async start(workspaceId: string, input: StartConversationInput) {
    if (!input.text?.trim() && !input.template) {
      throw new BadRequestException('Provide message text or a template');
    }

    const channel = await this.prisma.channel.findFirst({
      where: { id: input.channelId, workspaceId },
      select: { id: true, type: true, status: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.status && channel.status !== 'ACTIVE') {
      throw new BadRequestException(`Channel is ${channel.status}, not ACTIVE`);
    }

    const spec = INITIABLE[channel.type];
    if (!spec) {
      throw new BadRequestException(
        NOT_INITIABLE[channel.type] ??
          `A conversation cannot be started on a ${channel.type} channel.`,
      );
    }

    // Only the WhatsApp adapter reads `template`; every other adapter
    // destructures `{ config, to, text }` and drops it on the floor. The guard
    // above accepts "text OR template", so a template-only send on SMS or email
    // reached the adapter with text `''` — an empty message, and no error
    // anywhere to say the template had been ignored.
    if (!input.text?.trim() && !spec.supportsTemplate) {
      throw new BadRequestException(
        `A ${spec.label} message needs text — templates are a WhatsApp feature and are ignored on this channel.`,
      );
    }

    const lead = await this.prisma.lead.findFirst({
      where: { id: input.leadId, workspaceId, deletedAt: null, mergedIntoId: null },
      select: {
        id: true,
        phone: true,
        whatsapp: true,
        email: true,
        emailOptOut: true,
        smsOptOut: true,
        waOptOut: true,
        emailVerifiedStatus: true,
        emailBouncedAt: true,
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    // Opt-out is honoured everywhere else that reaches a lead — campaigns
    // suppress them, ConversationAiEngineService refuses to auto-reply, and
    // esp-feedback sets the flag on a hard bounce or spam report. The one path
    // that was NOT checking is the one whose entire purpose is contacting
    // someone who has not asked to be contacted.
    //
    // This is the unambiguous half of the question: whatever the İYS position
    // on a given recipient, a lead who said stop must not be messaged again.
    if (this.hasOptedOut(channel.type as ChannelType, lead)) {
      throw new BadRequestException(
        `This lead opted out of ${spec.label === 'email address' ? 'email' : spec.label.replace(' number', '')} messages, so a conversation cannot be started.`,
      );
    }

    // Address hygiene, on the same argument as opt-out. Campaigns, ad-audience
    // sync and the bulk email tool all exclude a hard-bounced or MX-invalid
    // address; individual sends did not, so the one path that reaches a
    // stranger could still mail a address every other path had written off.
    //
    // esp-feedback sets emailOptOut alongside emailBouncedAt, so a hard bounce
    // is already caught above — INVALID is the real gap, written independently
    // by the hygiene check at lead create/update. It matters most exactly now:
    // cold outreach runs from one domain, and mailing dead addresses is how
    // that domain's sending reputation gets spent.
    if (channel.type === 'EMAIL' && (lead.emailVerifiedStatus === 'INVALID' || lead.emailBouncedAt)) {
      throw new BadRequestException(
        lead.emailBouncedAt
          ? 'This email address has hard-bounced, so a conversation cannot be started.'
          : 'This email address failed verification, so a conversation cannot be started.',
      );
    }

    const address = this.addressFor(channel.type as ChannelType, lead);
    if (!address) {
      throw new BadRequestException(
        `This lead has no ${spec.label} on file, so there is nothing to send to.`,
      );
    }

    // An identity is unique per (channel, address). If one already exists on
    // another lead, the same person is on file twice — sending would attach
    // this thread to the wrong record, so refuse and let a human merge them.
    const existing = await this.prisma.contactIdentity.findFirst({
      // Across every spelling, not just the canonical one: an identity written
      // before addressFor produced E.164 is stored as "0555…", and an exact
      // match on "+90555…" would sail past this guard and attach the thread to
      // the wrong lead — the exact outcome the guard exists to prevent.
      where: {
        workspaceId,
        channelId: channel.id,
        value: { in: this.candidateValues(channel.type as ChannelType, address) },
      },
      select: { id: true, leadId: true },
    });
    if (existing && existing.leadId !== lead.id) {
      throw new ConflictException(
        'That address already belongs to a different lead on this channel — merge them first.',
      );
    }

    const identity =
      existing ??
      (await this.prisma.contactIdentity.create({
        data: {
          workspaceId,
          channelId: channel.id,
          kind: spec.kind,
          value: address,
          leadId: lead.id,
        },
        select: { id: true, leadId: true },
      }));

    // Reuse an open thread rather than opening a second one beside it — the
    // inbox would otherwise show the same person twice on the same channel.
    const open = await this.prisma.conversation.findFirst({
      where: { workspaceId, channelId: channel.id, contactIdentityId: identity.id, status: 'OPEN' },
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
    });
    const conversation =
      open ??
      (await this.prisma.conversation.create({
        data: {
          workspaceId,
          channelId: channel.id,
          leadId: lead.id,
          contactIdentityId: identity.id,
          status: 'OPEN',
        },
        select: { id: true },
      }));

    const message = await this.sender.send({
      workspaceId,
      conversationId: conversation.id,
      text: input.text ?? '',
      template: input.template,
      authorType: 'AI',
      authorId: null,
    });

    return {
      conversationId: conversation.id,
      leadId: lead.id,
      channel: channel.type,
      to: address,
      reusedThread: Boolean(open),
      message,
    };
  }
}
