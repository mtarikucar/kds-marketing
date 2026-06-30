import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
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
import { AdRulesService } from '../ads/ad-rules.service';

const METRICS = ['SPEND', 'CPL', 'CTR', 'LEADS', 'CLICKS', 'IMPRESSIONS'];
const OPERATORS = ['GT', 'LT', 'GTE', 'LTE'];
const ACTIONS = ['INCREASE_BUDGET', 'DECREASE_BUDGET', 'PAUSE', 'RESUME'];

class CreateAdRuleDto {
  @IsString() @MaxLength(100)
  adAccountId: string;

  @IsString() @MaxLength(120)
  name: string;

  @IsIn(METRICS)
  metric: string;

  @IsIn(OPERATORS)
  operator: string;

  @IsNumber()
  threshold: number;

  @IsIn(ACTIONS)
  action: string;

  @IsOptional() @IsInt() @Min(1) @Max(90)
  windowDays?: number;

  @IsOptional() @IsNumber() @Min(0)
  actionValue?: number;

  @IsOptional() @IsNumber() @Min(0)
  maxBudget?: number;

  @IsOptional() @IsNumber() @Min(0)
  minBudget?: number;

  @IsOptional() @IsInt() @Min(0)
  cooldownHours?: number;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

class UpdateAdRuleDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsIn(METRICS)
  metric?: string;

  @IsOptional() @IsIn(OPERATORS)
  operator?: string;

  @IsOptional() @IsNumber()
  threshold?: number;

  @IsOptional() @IsIn(ACTIONS)
  action?: string;

  @IsOptional() @IsInt() @Min(1) @Max(90)
  windowDays?: number;

  @IsOptional() @IsNumber() @Min(0)
  actionValue?: number;

  @IsOptional() @IsNumber() @Min(0)
  maxBudget?: number;

  @IsOptional() @IsNumber() @Min(0)
  minBudget?: number;

  @IsOptional() @IsInt() @Min(0)
  cooldownHours?: number;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

/**
 * Automated ad-scaling rules (Meta). Reads are reporting (`reports.read`);
 * create/update/delete/run are workspace config writes (MANAGER + settings.manage),
 * mirroring ad-account connect.
 */
@MarketingRoute()
@Controller('marketing/ads/rules')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingAdRulesController {
  constructor(private readonly rules: AdRulesService) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.rules.list(a.workspaceId);
  }

  @Post()
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad_rule.create', resourceType: 'ad_rule', captureBody: ['name', 'metric', 'action'] })
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreateAdRuleDto) {
    return this.rules.create(a.workspaceId, dto);
  }

  @Patch(':id')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad_rule.update', resourceType: 'ad_rule', resourceIdParam: 'id' })
  update(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateAdRuleDto,
  ) {
    return this.rules.update(a.workspaceId, id, dto);
  }

  @Delete(':id')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad_rule.delete', resourceType: 'ad_rule', resourceIdParam: 'id' })
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.rules.remove(a.workspaceId, id);
  }

  @Get(':id/logs')
  @RequirePermission('reports.read')
  logs(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.rules.listLogs(a.workspaceId, id);
  }

  /** Evaluate the rule immediately and return the actions it took. */
  @Post(':id/run')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad_rule.run', resourceType: 'ad_rule', resourceIdParam: 'id' })
  run(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.rules.runNow(a.workspaceId, id);
  }
}
