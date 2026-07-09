import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { NetsantralClient } from '../../netgsm/santral/netsantral.client';
import { IysClient } from '../../netgsm/iys/iys.client';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { toIysMsisdn } from '../utils/lead-normalize';
import { TelephonyCallbackDto } from '../dto/telephony-callback.dto';

/** İYS's documented per-account rate limit — SAME bucket/limit as
 *  `campaign-sender.service.ts`'s `iysPreflight`/`iysArmaPreflight` and
 *  `iys-sync.service.ts`'s `/iys/add` worker: `/iys/search` is one endpoint
 *  contending for one aggregate per-account cap, not a per-caller one, so
 *  this callback's search MUST share the same `AccountRateBudgeter` bucket
 *  (`'iys'`) rather than get its own — otherwise an unauthenticated visitor
 *  flooding this public endpoint (Final-review fix M1) could exhaust İYS's
 *  real account-level budget on its own, driving the SAME account's TİCARİ
 *  campaign preflights above into fail-closed İYS-unavailable aborts. */
const IYS_SEARCH_BUDGET_LIMIT = 10;
const IYS_SEARCH_BUDGET_WINDOW_MS = 60_000;

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
 *
 * The `/iys/search` call is ALSO budget-gated (Final-review fix M1) through
 * the same `AccountRateBudgeter` bucket the campaign preflights use — see the
 * module-level comment above. On denial this fails closed with a 503 and
 * never reaches `iysClient.search`/`client.dynamicRedirect`: a busy account
 * budget is throttling, not a compliance verdict, so it must never be
 * silently bypassed by placing the call anyway.
 */
@Injectable()
export class TelephonyCallbackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyConfig: TelephonyConfigService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly client: NetsantralClient,
    private readonly iysClient: IysClient,
    private readonly budgeter: AccountRateBudgeter,
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

    // Budget-gate BEFORE the search call — same bucket/limit as every other
    // İYS caller (see the module-level comment). Denial fails closed: never
    // fall through to the search or the call placement.
    if (!this.budgeter.tryTake(usercode, 'iys', IYS_SEARCH_BUDGET_LIMIT, IYS_SEARCH_BUDGET_WINDOW_MS)) {
      throw new ServiceUnavailableException('İYS doğrulaması şu anda meşgul, birazdan tekrar deneyin');
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
