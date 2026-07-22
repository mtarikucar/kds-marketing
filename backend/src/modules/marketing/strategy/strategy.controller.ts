import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { StrategyService, AUTONOMY_LEVELS } from './strategy.service';

const ACTION_STATUSES = ['PROPOSED', 'APPROVED', 'RUNNING', 'DONE', 'FAILED', 'DISMISSED'] as const;

class ListActionsQueryDto {
  @IsOptional() @IsIn(ACTION_STATUSES)
  status?: string;
}

class SetAutonomyDto {
  @IsIn(AUTONOMY_LEVELS as unknown as string[])
  level: string;
}

/**
 * Strategy Engine — the console read/decision surface over the synthesized
 * strategy + its ActionPlan. Reads are reports.read; the approve/dismiss/autonomy
 * decisions govern what the engine is allowed to execute, so they carry the same
 * MANAGER + settings.manage + audited stack as the budget-autopilot controls.
 */
@MarketingRoute()
@Controller('marketing/strategy')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class StrategyController {
  constructor(private readonly strategy: StrategyService) {}

  @Get()
  @RequirePermission('reports.read')
  getStrategy(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.strategy.getStrategy(a.workspaceId);
  }

  @Get('actions')
  @RequirePermission('reports.read')
  listActions(@CurrentMarketingUser() a: MarketingUserPayload, @Query() q: ListActionsQueryDto) {
    return this.strategy.listActions(a.workspaceId, { status: q.status });
  }

  @Post('actions/:id/approve')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.action.approve', resourceType: 'strategy_action', resourceIdParam: 'id' })
  approve(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.strategy.approveAction(a.workspaceId, id);
  }

  @Post('actions/:id/dismiss')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.action.dismiss', resourceType: 'strategy_action', resourceIdParam: 'id' })
  dismiss(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.strategy.dismissAction(a.workspaceId, id);
  }

  @Post('autonomy')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'strategy.autonomy', resourceType: 'marketing_strategy', captureBody: ['level'] })
  setAutonomy(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: SetAutonomyDto) {
    return this.strategy.setAutonomy(a.workspaceId, dto.level);
  }
}
