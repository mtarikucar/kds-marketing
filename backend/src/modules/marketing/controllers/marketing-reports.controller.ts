import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingReportsService } from '../services/marketing-reports.service';
import { ReportFilterDto } from '../dto/report-filter.dto';
import { MarketingUserPayload } from '../types';

@MarketingRoute()
@Controller('marketing/reports')
@UseGuards(MarketingGuard, MarketingRolesGuard)
export class MarketingReportsController {
  constructor(private readonly reportsService: MarketingReportsService) {}

  @Get('performance')
  @MarketingRoles('MANAGER')
  getPerformance(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query() filter: ReportFilterDto,
  ) {
    return this.reportsService.getPerformanceReport(actor.workspaceId, filter);
  }

  // Aggregate reports show data across every rep, so only managers
  // should see them; otherwise a REP can read the whole team's
  // conversion funnel and regional performance.
  @Get('lead-sources')
  @MarketingRoles('MANAGER')
  getLeadSources(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query() filter: ReportFilterDto,
  ) {
    return this.reportsService.getLeadSourceReport(actor.workspaceId, filter);
  }

  @Get('regional')
  @MarketingRoles('MANAGER')
  getRegional(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query() filter: ReportFilterDto,
  ) {
    return this.reportsService.getRegionalReport(actor.workspaceId, filter);
  }

  @Get('conversion')
  @MarketingRoles('MANAGER')
  getConversion(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query() filter: ReportFilterDto,
  ) {
    return this.reportsService.getConversionFunnel(actor.workspaceId, filter);
  }
}
