import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The ONE place inbound public webhooks resolve a channel WITHOUT a workspace
 * context (the provider only gives us a widget key or a page/phone id). Every
 * cross-workspace query lives here so the workspace-scoping arch spec has a
 * single, auditable exemption surface (see ALLOWED_GLOBAL). Resolution is by
 * globally-unique handles (widgetKey is @unique; (type, externalId) is the
 * provider identity a workspace registered), so it can't leak across tenants.
 */
@Injectable()
export class PublicChannelResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /** Web-chat widget → channel (widgetKey is globally unique). */
  async byWidgetKey(widgetKey: string) {
    return this.prisma.channel.findUnique({ where: { widgetKey } });
  }

  /** Meta webhook → channel by provider page/phone id (no workspace ctx yet). */
  async byExternalId(type: string, externalId: string) {
    return this.prisma.channel.findFirst({
      where: { type, externalId, status: 'ACTIVE' },
    });
  }

  /**
   * The same identity lookup, blind to `status` — for the REGISTRATION guard,
   * never for routing.
   *
   * `byExternalId` filters ACTIVE, which is right for delivering a webhook but
   * wrong for answering "is this identity already taken?". A DISABLED channel
   * read as free, so a second workspace could register the same
   * (type, externalId); once both rows were ACTIVE the `findFirst` above
   * returned whichever row Postgres scanned first, and one tenant received
   * another tenant's inbound messages.
   */
  async anyByExternalId(type: string, externalId: string) {
    return this.prisma.channel.findFirst({
      where: { type, externalId },
      select: { id: true, workspaceId: true, status: true },
    });
  }

  /**
   * A TOKENIZED callback URL → the channel it names. Used by NetGSM's inbound
   * SMS (MO) route and by the per-channel inbound-mail route.
   *
   * Cross-workspace by id here, and deliberately blind to `type` and `status`:
   * the caller has already authenticated with the per-channel token (only the
   * holder of MARKETING_SECRET_KEY can mint one), and it is the caller that
   * knows which type it will accept and how it wants to answer a channel that
   * is disabled — NetGSM and email both ACK an empty result rather than 404,
   * so a relay does not retry a mail we will never take. Everything downstream
   * is scoped to this row's `workspaceId`.
   *
   * This lookup is what makes the URL the tenant boundary: the id comes from a
   * path only we could have signed, so — unlike `byExternalId` — nothing a
   * sender writes can steer it into another tenant's row.
   */
  async channelForInbound(channelId: string) {
    return this.prisma.channel.findUnique({ where: { id: channelId } });
  }

  /** Twilio gather/status → the VOICE channel a call belongs to (CallSid is
   *  globally unique; the channel read is then workspace-scoped via the call). */
  async channelForVoiceCall(callSid: string) {
    const call = await this.prisma.voiceCall.findUnique({ where: { externalCallId: callSid } });
    if (!call) return null;
    return this.prisma.channel.findFirst({ where: { id: call.channelId, workspaceId: call.workspaceId } });
  }
}
