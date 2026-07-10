import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { TelephonyReportsService } from '../services/telephony-reports.service';
import { TelephonyStatisticsQueryDto } from '../dto/telephony-statistics.dto';
import { MarketingUserPayload } from '../types';

/**
 * Inbound call statistics for the reports page (NetGSM Phase 4 Task 5).
 * Same guard shape as MarketingReportsController's aggregate reports —
 * `@MarketingRoles('MANAGER')` because this shows whole-workspace call
 * volume, not a single rep's own activity — but gated on the `telephony`
 * feature (not `advancedReports`) since it's a telephony surface that only
 * makes sense once Netsantral is configured, mirroring TelephonyQueueController
 * living at the same `marketing/telephony` prefix.
 */
@MarketingRoute()
@RequiresFeature('telephony')
@Controller('marketing/telephony')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard)
export class TelephonyReportsController {
  constructor(private readonly reports: TelephonyReportsService) {}

  @Get('statistics')
  @MarketingRoles('MANAGER')
  statistics(@CurrentMarketingUser() user: MarketingUserPayload, @Query() query: TelephonyStatisticsQueryDto) {
    return this.reports.statistics(user.workspaceId, query.from, query.to);
  }
}
