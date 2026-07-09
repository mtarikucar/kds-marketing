import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { NetsantralClient, NetsantralCreds } from '../../netgsm/santral/netsantral.client';
import { MarketingUserPayload } from '../types';
import { TransferCallDto, MuteCallDto } from '../dto/telephony-control.dto';

/**
 * In-call control (NetGSM Phase 3 Task 5) — hangup, blind/attended transfer,
 * and mute, all acting on the LIVE netsantral call identified by
 * `SalesCall.externalCallId` (the santral `unique_id`, backfilled by
 * TelephonyEventConsumer once the call rings/answers — see that file's
 * class docstring). A call placed through the `netgsm-lite` click-to-dial
 * provider never gets an externalCallId, so every action here correctly
 * 400s for it: there is no live PBX leg to control.
 *
 * Ownership mirrors SalesCallService.get: a REP may only control their own
 * calls; MANAGER/OWNER may control any call in the workspace. Final-review
 * MEDIUM-1 fix: "their own" also includes a call the REP personally
 * answered (`SalesCall.answeredByUserId`) even when `marketingUserId` is
 * null/someone-else — an inbound call to an unmatched extension or a
 * hunt-group route has no attributed owner (or the wrong one) until
 * TelephonyEventConsumer.handleAnswer stamps `answeredByUserId` from the
 * santral `answer` event's own internal_num, so without this a rep who
 * genuinely picked up the phone could never hang up/transfer/mute the call
 * they're actively on.
 */
@Injectable()
export class TelephonyControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyConfig: TelephonyConfigService,
    private readonly client: NetsantralClient,
  ) {}

  async hangup(workspaceId: string, callId: string, user: MarketingUserPayload) {
    const { call, creds } = await this.resolveLiveCall(workspaceId, callId, user);
    const outcome = await this.client.hangup(creds, call.externalCallId!);
    if (!outcome.ok) {
      throw new BadRequestException(outcome.message ?? 'Netsantral rejected the hangup request.');
    }
    return { ok: true };
  }

  async transfer(workspaceId: string, callId: string, user: MarketingUserPayload, dto: TransferCallDto) {
    const { call, creds } = await this.resolveLiveCall(workspaceId, callId, user);
    const target = await this.prisma.marketingUser.findFirst({
      where: { workspaceId, dahili: dto.targetDahili, status: 'ACTIVE' },
      select: { dahili: true },
    });
    if (!target?.dahili) {
      throw new NotFoundException("Transfer target is not a teammate's extension in this workspace");
    }
    const outcome = dto.attended
      ? await this.client.attendedTransfer(creds, call.externalCallId!, target.dahili)
      : await this.client.blindTransfer(creds, call.externalCallId!, target.dahili);
    if (!outcome.ok) {
      throw new BadRequestException(outcome.message ?? 'Netsantral rejected the transfer request.');
    }
    return { ok: true };
  }

  async mute(workspaceId: string, callId: string, user: MarketingUserPayload, dto: MuteCallDto) {
    const { call, creds } = await this.resolveLiveCall(workspaceId, callId, user);
    const outcome = await this.client.mute(creds, call.externalCallId!, dto.on);
    if (!outcome.ok) {
      throw new BadRequestException(outcome.message ?? 'Netsantral rejected the mute request.');
    }
    return { ok: true };
  }

  /**
   * Workspace + ownership scoped SalesCall lookup that also requires a LIVE
   * `unique_id`, plus the workspace's resolved netsantral creds. Shared guard
   * for all three control actions.
   */
  private async resolveLiveCall(
    workspaceId: string,
    callId: string,
    user: MarketingUserPayload,
  ): Promise<{ call: { id: string; externalCallId: string }; creds: NetsantralCreds }> {
    const call = await this.prisma.salesCall.findFirst({ where: { id: callId, workspaceId } });
    if (!call) throw new NotFoundException('Call not found');
    // MEDIUM-1 fix: the REP who ANSWERED the call (answeredByUserId) may
    // control it too, not just the call's attributed marketingUserId owner —
    // an unmatched/hunt-group inbound call's marketingUserId can be null or a
    // different rep entirely even though THIS rep is the one actually on it.
    if (user.role === 'REP' && call.marketingUserId !== user.id && call.answeredByUserId !== user.id) {
      throw new ForbiddenException('You can only control your own calls');
    }
    if (!call.externalCallId) {
      throw new BadRequestException('Call has no live id yet');
    }
    const creds = await this.telephonyConfig.resolveForWorkspace(workspaceId);
    if (!creds) {
      throw new ServiceUnavailableException('Netsantral is not configured for this workspace');
    }
    return { call: { id: call.id, externalCallId: call.externalCallId }, creds };
  }
}
