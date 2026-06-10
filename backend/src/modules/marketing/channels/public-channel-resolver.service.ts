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

  /** Twilio gather/status → the VOICE channel a call belongs to (CallSid is
   *  globally unique; the channel read is then workspace-scoped via the call). */
  async channelForVoiceCall(callSid: string) {
    const call = await this.prisma.voiceCall.findUnique({ where: { externalCallId: callSid } });
    if (!call) return null;
    return this.prisma.channel.findFirst({ where: { id: call.channelId, workspaceId: call.workspaceId } });
  }

  /** NetGSM DLR → update an outbound message's delivery status by its provider
   *  job id (externalMessageId is globally unique). Returns rows touched. */
  async markDeliveryStatus(externalMessageId: string, status: string): Promise<number> {
    const res = await this.prisma.message.updateMany({
      where: { externalMessageId },
      data: { status },
    });
    return res.count;
  }
}
