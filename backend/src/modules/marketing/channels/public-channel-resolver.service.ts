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

  /** NetGSM MO webhook → the channel by its id (carried, token-signed, in the
   *  callback URL). Cross-workspace by id here; the caller authenticates via the
   *  per-channel token and scopes all downstream work to the row's workspaceId. */
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
