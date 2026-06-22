import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { DialerService } from '../services/dialer.service';
import { CreateDialSessionDto, DialOutcomeDto } from '../dto/dialer.dto';

/**
 * Preview dialer (Epic 11b) — a rep works an ordered queue of leads one at a
 * time, reusing the single-line click-to-dial path. Sessions are owned by the
 * creating rep; REP callers are clamped to their own assigned leads.
 */
@MarketingRoute()
@RequiresFeature('telephony')
@Controller('marketing/dialer/sessions')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
export class DialerController {
  constructor(private readonly dialer: DialerService) {}

  @Post()
  @RequirePermission('leads.write')
  create(@Body() dto: CreateDialSessionDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.dialer.createSession(u.workspaceId, u.id, u.role, dto);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.dialer.getSession(u.workspaceId, id, u.id);
  }

  @Post(':id/dial')
  @RequirePermission('leads.write')
  dial(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.dialer.dial(u.workspaceId, id, u.id);
  }

  @Post(':id/log')
  @RequirePermission('leads.write')
  log(@Param('id') id: string, @Body() dto: DialOutcomeDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.dialer.logOutcome(u.workspaceId, id, u.id, dto);
  }

  @Post(':id/skip')
  @RequirePermission('leads.write')
  skip(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.dialer.skip(u.workspaceId, id, u.id);
  }

  @Post(':id/cancel')
  @RequirePermission('leads.write')
  cancel(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.dialer.cancel(u.workspaceId, id, u.id);
  }
}
