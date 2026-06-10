import { Controller, Get, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingDashboardService } from '../services/marketing-dashboard.service';
import { MarketingUserPayload } from '../types';

@MarketingRoute()
@Controller('marketing/dashboard')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class MarketingDashboardController {
  constructor(private readonly dashboardService: MarketingDashboardService) {}

  @Get('stats')
  getStats(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.dashboardService.getStats(user.workspaceId, user.id, user.role);
  }

  @Get('leads-by-status')
  getLeadsByStatus(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.dashboardService.getLeadsByStatus(user.workspaceId, user.id, user.role);
  }

  @Get('today')
  getTodaySummary(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.dashboardService.getTodaySummary(user.workspaceId, user.id, user.role);
  }

  @Get('monthly')
  getMonthlyMetrics(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.dashboardService.getMonthlyMetrics(user.workspaceId, user.id, user.role);
  }

  @Get('top-performers')
  @MarketingRoles('MANAGER')
  getTopPerformers(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.dashboardService.getTopPerformers(user.workspaceId);
  }
}
