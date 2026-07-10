import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { TelephonyCallbackService } from '../services/telephony-callback.service';
import { TelephonyCallbackDto } from '../dto/telephony-callback.dto';
import { MarketingUserPayload } from '../types';

/**
 * Rep-triggered "call this number back now" (NetGSM Phase 5 Task 6) — same
 * guard chain as the rest of the telephony surface (`telephony` feature,
 * `leads.write` since it places a real outbound call). Lives at
 * `marketing/telephony/callback`, alongside TelephonyControlController/
 * TelephonyQueueController. The public funnel/webchat 'callback' block posts
 * to a SEPARATE, unauthenticated route (`PublicSiteController`'s
 * `POST /api/public/callback/:ws`) that calls the exact same
 * `TelephonyCallbackService.requestCallback` — the İYS-mandatory gate is
 * identical either way.
 */
@MarketingRoute()
@RequiresFeature('telephony')
@Controller('marketing/telephony')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
export class TelephonyCallbackController {
  constructor(private readonly callback: TelephonyCallbackService) {}

  @Post('callback')
  @RequirePermission('leads.write')
  request(@Body() dto: TelephonyCallbackDto, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.callback.requestCallback(user.workspaceId, dto);
  }
}
