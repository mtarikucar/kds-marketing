import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { AutocallDialerService } from '../services/autocall-dialer.service';
import { StartAutocallSessionDto, StopAutocallSessionDto } from '../dto/autocall-dialer.dto';

/**
 * Parallel power-dialer (NetGSM Phase 5 Task 5) — the "parallel mode"
 * counterpart to `DialerController`'s preview (one-at-a-time) queue. Requires
 * the paid NetGSM "Otomatik Arama" add-on + a pre-staffed Netsantral queue at
 * the NetGSM/provider level (this app cannot verify either — see
 * AutocallDialerService's docstring).
 *
 * Gated on `voiceCampaigns` (Final-review fix M4 — owner decision, per the
 * Phase-5 plan): the parallel dialer is a premium voice surface, same
 * SCALE+/add-on tier as the rest of the voice-campaign feature set (see
 * MarketingCampaignsController's `voice/audio` upload endpoint and
 * `FEATURE_KEYS`'s `voiceCampaigns` docstring in entitlements.service.ts) —
 * NOT the base `telephony` key every other Netsantral-surface controller
 * here uses. A workspace entitled to `telephony` (inbound/basic PBX) but not
 * `voiceCampaigns` must not get the paid parallel dialer for free.
 * `FeatureGuard` stays in the guard chain (tripwire).
 */
@MarketingRoute()
@RequiresFeature('voiceCampaigns')
@Controller('marketing/dialer/parallel')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
export class AutocallDialerController {
  constructor(private readonly dialer: AutocallDialerService) {}

  /** The workspace's current ACTIVE session, or null — backs the frontend
   *  toggle's on-load state. */
  @Get('active')
  active(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.dialer.getActive(u.workspaceId);
  }

  @Post('start')
  @RequirePermission('leads.write')
  start(@Body() dto: StartAutocallSessionDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.dialer.start(u.workspaceId, u.id, u.role, dto);
  }

  @Post('stop')
  @RequirePermission('leads.write')
  stop(@Body() dto: StopAutocallSessionDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.dialer.stop(u.workspaceId, dto.sessionId, u.id);
  }
}
