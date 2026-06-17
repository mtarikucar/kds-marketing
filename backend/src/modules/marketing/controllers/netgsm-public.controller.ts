import {
  Controller,
  Post,
  Param,
  Body,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PublicChannelResolverService } from '../channels/public-channel-resolver.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { ConversationIngressService } from '../channels/conversation-ingress.service';
import { verifyNetgsmMoToken } from '../channels/netgsm-callback.util';

/**
 * NetGSM public callbacks. Two flavours:
 *
 *  - Inbound MO replies (POST :channelId/:token/mo): NetGSM's "İnteraktif SMS →
 *    URL Adresine Yönlendir" posts each customer reply as JSON. NetGSM does NOT
 *    sign callbacks, so the URL carries an HMAC token per channel; we verify it,
 *    resolve the SMS channel, parse the reply, and funnel it through
 *    ConversationIngress (the same path Meta/WhatsApp use).
 *
 *  - Delivery reports are NOT pushed by NetGSM — they are polled from /sms/report
 *    by NetgsmDlrPollService. The legacy /dlr push handler below is retained only
 *    as a tolerant no-op shim for any account/proxy still configured to POST it.
 */
@Controller('public/channels/netgsm')
export class NetgsmPublicController {
  private readonly logger = new Logger(NetgsmPublicController.name);

  constructor(
    private readonly resolver: PublicChannelResolverService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly ingress: ConversationIngressService,
  ) {}

  @Post(':channelId/:token/mo')
  async mo(
    @Param('channelId') channelId: string,
    @Param('token') token: string,
    @Body() body: any,
  ): Promise<{ ok: boolean; received: number }> {
    // Authenticate first — reject before any DB work so a forged URL can't probe.
    if (!verifyNetgsmMoToken(channelId, token)) {
      throw new UnauthorizedException('invalid callback token');
    }
    const channel = await this.resolver.channelForInbound(channelId);
    if (
      !channel ||
      channel.type !== 'SMS' ||
      channel.status !== 'ACTIVE' ||
      !this.registry.has('SMS')
    ) {
      this.logger.warn(`netgsm MO for unusable channel id=${channelId} — acking empty`);
      return { ok: true, received: 0 };
    }
    const adapter = this.registry.get('SMS');
    const config = this.registry.resolveConfig(channel);
    const inbounds = adapter.parseInbound ? adapter.parseInbound(config, body) : [];
    let received = 0;
    for (const msg of inbounds) {
      // workspace-scoped via the resolved channel row.
      await this.ingress.ingest(
        { id: channel.id, workspaceId: channel.workspaceId, type: channel.type },
        msg,
      );
      received++;
    }
    return { ok: true, received };
  }

  @Post('dlr')
  async dlr(@Body() body: any): Promise<{ ok: boolean; updated: number }> {
    // NetGSM does NOT push delivery reports — they are POLLED from /sms/report by
    // NetgsmDlrPollService. This legacy push route is intentionally a no-op that
    // performs NO writes. It previously updated Message.status keyed only on a
    // caller-supplied, low-entropy job id, with no token and no workspace scope —
    // letting any unauthenticated caller flip arbitrary tenants' delivery status.
    // We log and ack so a stray/misconfigured POST neither errors nor retry-storms.
    const count = Array.isArray(body) ? body.length : body ? 1 : 0;
    if (count > 0) {
      this.logger.warn(
        `ignoring ${count} pushed NetGSM DLR row(s) — delivery reports are polled, not pushed`,
      );
    }
    return { ok: true, updated: 0 };
  }
}
