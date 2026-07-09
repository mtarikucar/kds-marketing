import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { TelephonyControlService } from '../services/telephony-control.service';
import { SalesCallService } from '../services/sales-call.service';
import { TransferCallDto, MuteCallDto } from '../dto/telephony-control.dto';
import { MarketingUserPayload } from '../types';

/**
 * In-call control over the LIVE netsantral call (NetGSM Phase 3 Task 5) —
 * hangup, blind/attended transfer, and mute. Same guard chain as
 * SalesCallController (`telephony` feature + `leads.write`); the path lives
 * under `marketing/telephony/calls` (distinct from SalesCallController's
 * `marketing/calls`) alongside the rest of the telephony surface
 * (TelephonyConfigController/TelephonyStreamController).
 *
 * Also hosts `GET :id/recording` (NetGSM Phase 4 Task 3) — a read-only lookup
 * of a playable recording URL, guarded by `leads.read` (not `leads.write`
 * like the in-call actions above) since it never mutates a live call.
 */
@MarketingRoute()
@RequiresFeature('telephony')
@Controller('marketing/telephony/calls')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
export class TelephonyControlController {
  constructor(
    private readonly control: TelephonyControlService,
    private readonly calls: SalesCallService,
  ) {}

  @Post(':id/hangup')
  @RequirePermission('leads.write')
  hangup(@Param('id') id: string, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.control.hangup(user.workspaceId, id, user);
  }

  @Post(':id/transfer')
  @RequirePermission('leads.write')
  transfer(
    @Param('id') id: string,
    @Body() dto: TransferCallDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.control.transfer(user.workspaceId, id, user, dto);
  }

  @Post(':id/mute')
  @RequirePermission('leads.write')
  mute(
    @Param('id') id: string,
    @Body() dto: MuteCallDto,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    return this.control.mute(user.workspaceId, id, user, dto);
  }

  /**
   * A playable URL for this call's recording, for the frontend's in-app
   * `<audio>` player (NetGSM Phase 4 Task 3). `SalesCallService.getRecordingUrl`
   * does the actual resolution — R2-stored copy preferred, provider url
   * fallback, 404 when neither exists — and enforces the same
   * workspace/rep-ownership scope as every other call-detail read.
   */
  @Get(':id/recording')
  @RequirePermission('leads.read')
  recording(@Param('id') id: string, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.calls.getRecordingUrl(user.workspaceId, id, user);
  }
}
