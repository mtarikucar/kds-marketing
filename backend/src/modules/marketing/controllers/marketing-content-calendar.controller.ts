import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { UnifiedCalendarService } from '../trends/unified-calendar.service';

/**
 * Unified content calendar (Faz 4) — one time-ordered view across the siloed
 * schedules (social posts + AI social-campaign items). Read-only. Defaults to
 * the next 60 days when no range is given; caps the window at 180 days.
 */
@MarketingRoute()
@Controller('marketing/content-calendar')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingContentCalendarController {
  constructor(private readonly calendar: UnifiedCalendarService) {}

  @Get()
  @RequirePermission('reports.read')
  range(@CurrentMarketingUser() a: MarketingUserPayload, @Query('from') fromRaw?: string, @Query('to') toRaw?: string) {
    const now = Date.now();
    const from = fromRaw ? new Date(fromRaw) : new Date(now - 7 * 86_400_000);
    const to = toRaw ? new Date(toRaw) : new Date(now + 60 * 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('invalid date range');
    if (to <= from) throw new BadRequestException('`to` must be after `from`');
    if (to.getTime() - from.getTime() > 180 * 86_400_000) throw new BadRequestException('range too wide (max 180 days)');
    return this.calendar.range(a.workspaceId, from, to);
  }
}
