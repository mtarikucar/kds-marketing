import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { SalesTargetService } from '../services/sales-target.service';
import { SetTargetDto, TargetFilterDto } from '../dto/sales-target.dto';
import { MarketingUserPayload } from '../types';

/**
 * Phase 4: sales targets/quotas + performance-vs-target. Setting/removing
 * targets is MANAGER-only (the approval gate). Reps see only their own
 * targets/performance; managers see any rep or the whole team.
 */
@MarketingRoute()
@Controller('marketing')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class SalesTargetController {
  constructor(private readonly targets: SalesTargetService) {}

  @Post('targets')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  set(@Body() dto: SetTargetDto, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.targets.setTarget(user.workspaceId, dto, user.id);
  }

  @Get('targets')
  list(@Query() filter: TargetFilterDto, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.targets.list(user.workspaceId, filter, user);
  }

  @Delete('targets/:id')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  remove(@Param('id') id: string, @CurrentMarketingUser() user: MarketingUserPayload) {
    return this.targets.remove(user.workspaceId, id);
  }

  @Get('performance')
  performance(
    @Query('period') period: string | undefined,
    @Query('marketingUserId') marketingUserId: string | undefined,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ) {
    const p = period && /^\d{4}-\d{2}$/.test(period) ? period : this.currentPeriod();
    // Reps see only their own attainment; managers see a specific rep or the team.
    if (user.role === 'REP') {
      return this.targets.performanceFor(user.workspaceId, user.id, p);
    }
    if (marketingUserId) {
      return this.targets.performanceFor(user.workspaceId, marketingUserId, p);
    }
    return this.targets.teamPerformance(user.workspaceId, p);
  }

  private currentPeriod(): string {
    return new Date().toISOString().slice(0, 7);
  }
}
