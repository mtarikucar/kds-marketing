import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { GamificationService } from './gamification.service';
import { CreateBadgeDto, UpdateBadgeDto } from './gamification.dto';

/**
 * Epic 10c — membership gamification: the workspace points leaderboard, a
 * member's points/badge profile, and manager badge administration. All
 * workspace-scoped; badge mutations are MANAGER-only.
 */
@MarketingRoute()
@Controller('marketing/gamification')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class GamificationController {
  constructor(private readonly svc: GamificationService) {}

  @Get('leaderboard')
  leaderboard(
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.leaderboard(u.workspaceId, Number(page) || 1, Number(pageSize) || 20);
  }

  @Get('badges')
  listBadges(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listBadges(u.workspaceId);
  }

  @Post('badges')
  @MarketingRoles('MANAGER')
  @Audit({ action: 'badge.create', resourceType: 'badge', captureBody: ['key', 'ruleType', 'threshold'] })
  createBadge(@Body() dto: CreateBadgeDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.createBadge(u.workspaceId, dto);
  }

  @Patch('badges/:id')
  @MarketingRoles('MANAGER')
  @Audit({ action: 'badge.update', resourceType: 'badge', resourceIdParam: 'id' })
  updateBadge(@Param('id') id: string, @Body() dto: UpdateBadgeDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.updateBadge(u.workspaceId, id, dto);
  }

  @Delete('badges/:id')
  @MarketingRoles('MANAGER')
  @Audit({ action: 'badge.delete', resourceType: 'badge', resourceIdParam: 'id' })
  deleteBadge(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.deleteBadge(u.workspaceId, id);
  }

  /** A member's gamification profile (points + earned badges). */
  @Get('profile/:leadId')
  profile(@Param('leadId') leadId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.profile(u.workspaceId, leadId);
  }
}
