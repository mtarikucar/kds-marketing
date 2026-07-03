import { Controller, Get, Post, Patch, Body, Param, UseGuards } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { BudgetManagementService } from '../budget/budget-management.service';
import { BudgetAutopilotService } from '../budget/budget-autopilot.service';

const CHANNELS = ['META', 'TIKTOK', 'GOOGLE', 'LINKEDIN', 'CONTENT', 'SMS', 'VOICE', 'WHATSAPP'];

class UpsertBudgetDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) periodKey: string;
  @IsNumber() @Min(0) totalAmount: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsIn(['HOLISTIC', 'AD_ONLY']) scope?: 'HOLISTIC' | 'AD_ONLY';
  @IsOptional() @IsInt() @Min(0) @Max(90) explorationPct?: number;
  @IsOptional() @IsNumber() @Min(0) targetRoas?: number;
  @IsOptional() @IsNumber() @Min(0) targetCac?: number;
}

class KillSwitchDto {
  @IsBoolean() on: boolean;
}

class StatusDto {
  @IsIn(['ACTIVE', 'PAUSED', 'KILLED']) status: string;
}

class UpsertAllocationDto {
  @IsIn(CHANNELS) channel: string;
  @IsOptional() @IsString() @MaxLength(120) campaignRef?: string;
  @IsNumber() @Min(0) plannedAmount: number;
}

/**
 * Budget Autopilot management surface. Reads are reports.read; every mutation
 * is MANAGER + settings.manage + audited — the same guard stack as ad rules,
 * because these endpoints govern real ad spend. `propose` runs the SHADOW
 * allocator only (no money moves) until autonomy ships in a later slice.
 */
@MarketingRoute()
@Controller('marketing/budget')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingBudgetController {
  constructor(
    private readonly budgets: BudgetManagementService,
    private readonly autopilot: BudgetAutopilotService,
  ) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.budgets.list(a.workspaceId);
  }

  @Post()
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'growth_budget.upsert', resourceType: 'growth_budget', captureBody: ['periodKey', 'totalAmount', 'scope'] })
  upsert(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: UpsertBudgetDto) {
    return this.budgets.upsertBudget(a.workspaceId, dto);
  }

  @Get(':id')
  @RequirePermission('reports.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.budgets.get(a.workspaceId, id);
  }

  @Patch(':id/kill')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'growth_budget.kill', resourceType: 'growth_budget', resourceIdParam: 'id' })
  kill(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: KillSwitchDto) {
    return this.budgets.setKillSwitch(a.workspaceId, id, dto.on);
  }

  @Patch(':id/status')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'growth_budget.status', resourceType: 'growth_budget', resourceIdParam: 'id' })
  status(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: StatusDto) {
    return this.budgets.setStatus(a.workspaceId, id, dto.status);
  }

  @Post(':id/allocations')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'growth_budget.allocation', resourceType: 'growth_budget', resourceIdParam: 'id' })
  allocate(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: UpsertAllocationDto) {
    return this.budgets.upsertAllocation(a.workspaceId, id, dto);
  }

  @Post(':id/propose')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'growth_budget.propose', resourceType: 'growth_budget', resourceIdParam: 'id' })
  propose(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.autopilot.propose(a.workspaceId, id);
  }

  @Get(':id/runs')
  @RequirePermission('reports.read')
  runs(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.budgets.listRuns(a.workspaceId, id);
  }
}
