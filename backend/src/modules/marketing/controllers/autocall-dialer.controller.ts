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
 * counterpart to `DialerController`'s preview (one-at-a-time) queue. Guarded
 * by the SAME `telephony` feature key as the preview dialer; requires the
 * paid NetGSM "Otomatik Arama" add-on + a pre-staffed Netsantral queue at
 * the NetGSM/provider level (this app cannot verify either — see
 * AutocallDialerService's docstring).
 */
@MarketingRoute()
@RequiresFeature('telephony')
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
