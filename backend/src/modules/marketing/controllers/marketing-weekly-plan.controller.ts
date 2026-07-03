import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { WeeklyPlannerService } from '../studio/weekly-planner.service';

class GenerateDto {
  @IsOptional() @IsString() weekStart?: string; // ISO date; defaults to this week
}

/**
 * Weekly Planner (Faz C) — one click generates a full week of DRAFT content +
 * a budget analysis. Nothing publishes; the user approves/discards each item.
 * MANAGER-gated + audited (it reads the budget and drafts real content).
 */
@MarketingRoute()
@Controller('marketing/weekly-plan')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingWeeklyPlanController {
  constructor(private readonly planner: WeeklyPlannerService) {}

  @Post('generate')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'weekly_plan.generate', resourceType: 'weekly_plan' })
  generate(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: GenerateDto) {
    return this.planner.generate(a.workspaceId, dto.weekStart);
  }

  @Get(':id')
  @RequirePermission('reports.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.planner.get(a.workspaceId, id);
  }

  @Post('items/:id/:decision')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'weekly_plan.decide', resourceType: 'weekly_plan_item', resourceIdParam: 'id' })
  decide(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Param('decision') decision: string,
  ) {
    const status = decision === 'approve' ? 'APPROVED' : 'DISCARDED';
    return this.planner.decideItem(a.workspaceId, id, status);
  }
}
