import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { NetsantralClient } from '../../netgsm/santral/netsantral.client';
import { IysClient } from '../../netgsm/iys/iys.client';
import { toIysMsisdn } from '../utils/lead-normalize';
import { TelephonyCallbackDto } from '../dto/telephony-callback.dto';

/**
 * "Leave your number, we call you now" callback (NetGSM Phase 5 Task 6) —
 * places a REAL outbound call via Netsantral's `dynamic_redirect` straight
 * into a pre-existing queue/IVR/announcement object. Shared by the
 * authenticated `POST /marketing/telephony/callback` (rep-triggered, see
 * TelephonyCallbackController) and the public funnel/webchat 'callback'
 * block (visitor-triggered, see PublicSiteController) — both funnel through
 * `requestCallback` so the compliance gate below applies identically no
 * matter who submitted the number.
 *
 * İYS gate is MANDATORY and fail-closed, mirroring `campaign-sender.service`'s
 * TİCARİ ARAMA voice-campaign preflight exactly (same brandCode source, same
 * `IysClient.search(..., 'ARAMA')` call, same RET/YOK block): every callback
 * is treated as commercial-grade regardless of how the caller framed the
 * request — there is no "skip the check, this one's informational" path,
 * since a mis-classified callback is an unrecoverable real phone call, not a
 * reversible write.
 */
@Injectable()
export class TelephonyCallbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyConfig: TelephonyConfigService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly client: NetsantralClient,
    private readonly iysClient: IysClient,
  ) {}

  async requestCallback(workspaceId: string, dto: TelephonyCallbackDto): Promise<{ ok: true }> {
    const netsantralCreds = await this.telephonyConfig.resolveForWorkspace(workspaceId);
    if (!netsantralCreds) {
      throw new ServiceUnavailableException('Netsantral is not configured for this workspace');
    }

    // Same account resolution as VOICE campaigns (campaign-sender.service's
    // sendVoice): the voicesms/İYS family authenticates with the ACTIVE SMS
    // channel's account, not the Netsantral PBX creds above.
    const smsChannel = await this.prisma.channel.findFirst({ where: { workspaceId, type: 'SMS', status: 'ACTIVE' } });
    const resolved = smsChannel ? this.registry.resolveConfig(smsChannel) : null;
    const usercode = resolved?.secrets?.usercode;
    const password = resolved?.secrets?.password;
    const brandCode = typeof resolved?.public?.brandCode === 'string' ? (resolved.public.brandCode as string).trim() : '';
    if (!usercode || !password) {
      throw new ServiceUnavailableException('No active SMS/voice account configured for İYS verification');
    }

    // İYS filter is MANDATORY for a callback — refuse outright without a
    // brandCode (fail-closed, same contract as iysArmaPreflight's own
    // brandCode gate): there is no anonymous/uncategorized callback.
    if (!brandCode) {
      throw new BadRequestException('İYS brandcode is not configured — cannot place a callback');
    }
    const wirePhone = toIysMsisdn(dto.phone);
    if (!wirePhone) {
      throw new BadRequestException('Invalid phone number');
    }

    const consent = await this.iysClient.search({ usercode, password, brandCode }, wirePhone, 'ARAMA');
    if (!consent.ok || consent.status === null) {
      // İYS unreachable/unclassifiable — fail closed, never place the call.
      throw new ServiceUnavailableException(consent.message ?? 'İYS is unreachable — refusing the callback (fail closed)');
    }
    if (consent.status === 'RET' || consent.status === 'YOK') {
      throw new BadRequestException('İYS: bu numara için arama izni yok (RET/kayıt yok)');
    }

    const outcome = await this.client.dynamicRedirect(netsantralCreds, {
      phone: wirePhone,
      redirectMenu: dto.redirectMenu,
      redirectType: dto.redirectType,
      iysfilter: '11',
      brandcode: brandCode,
    });
    if (!outcome.ok) {
      throw new BadRequestException(outcome.message ?? 'Netsantral rejected the callback request.');
    }
    return { ok: true };
  }
}
