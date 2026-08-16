import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Throttle } from '@nestjs/throttler';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { PageViewStatsService } from './page-view-stats.service';

export class RecordPageViewDto {
  /** The router PATTERN of the screen that opened, e.g. `/leads/:id`. */
  @IsString()
  @MaxLength(200)
  route: string;
}

export class PageViewSummaryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  months?: number;
}

/**
 * Which screens are actually opened.
 *
 * Recording is open to any signed-in member — it is their own navigation, and
 * gating it would bias the data toward managers. READING is manager-only:
 * usage patterns are a management view, and the numbers exist to decide which
 * screens get retired.
 */
@MarketingRoute()
@Controller('marketing/page-views')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class PageViewStatsController {
  constructor(private readonly stats: PageViewStatsService) {}

  /** Fire-and-forget from the client; 204 so nothing is tempted to parse it. */
  @Post()
  @HttpCode(204)
  // One per navigation is the honest rate; this only stops a loop from
  // hammering the counter.
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async record(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: RecordPageViewDto,
  ): Promise<void> {
    await this.stats.record(actor.workspaceId, dto.route);
  }

  @Get()
  @MarketingRoles('MANAGER')
  @RequirePermission('reports.read')
  summary(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query() q: PageViewSummaryDto,
  ) {
    return this.stats.summary(actor.workspaceId, q.months ?? 3);
  }
}
