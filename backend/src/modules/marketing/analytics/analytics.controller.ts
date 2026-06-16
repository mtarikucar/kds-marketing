import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { AnalyticsService } from './analytics.service';

@MarketingRoute()
@Controller('marketing/analytics')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  @Get('funnel')
  funnel(
    @Query('from') from: string,
    @Query('to') to: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.funnel(u.workspaceId, { from, to });
  }

  @Get('by-source')
  bySource(
    @Query('from') from: string,
    @Query('to') to: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.bySource(u.workspaceId, { from, to });
  }

  @Get('by-business-type')
  byBusinessType(
    @Query('from') from: string,
    @Query('to') to: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.byBusinessType(u.workspaceId, { from, to });
  }

  @Get('rep-performance')
  repPerformance(
    @Query('from') from: string,
    @Query('to') to: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.repPerformance(u.workspaceId, { from, to });
  }
}
