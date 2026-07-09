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
import { IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { AdAccountService } from '../ads/ad-account.service';
import { AdManagementService } from '../ads/ad-management.service';
import {
  ConnectAdAccountDto,
  AdMetricsQueryDto,
  PullAdAccountDto,
} from '../dto/ad-account.dto';

class SetBudgetDto {
  @IsNumber() @Min(0.01)
  dailyBudget: number;
}
class SetStatusDto {
  @IsIn(['ACTIVE', 'PAUSED'])
  status: 'ACTIVE' | 'PAUSED';
}
// Named distinctly from the marketing CreateCampaignDto (dto/campaign.dto.ts) so
// Swagger doesn't collide two different schemas under one model name.
class CreateAdCampaignDto {
  @IsString() @MaxLength(200)
  name: string;

  /** Meta outcome objective, e.g. OUTCOME_LEADS / OUTCOME_TRAFFIC / OUTCOME_SALES. */
  @IsString() @MaxLength(60)
  objective: string;
}

/** Launch a full Meta ad end-to-end from a generated creative asset. */
class LaunchAdDto {
  @IsString() @MaxLength(64) generatedAssetId: string;
  @IsOptional() @IsString() @MaxLength(64) campaignId?: string;
  @IsOptional() @IsString() @MaxLength(200) campaignName?: string;
  @IsOptional() @IsString() @MaxLength(60) objective?: string;
  @IsString() @MaxLength(200) adsetName: string;
  @IsNumber() @Min(0.01) dailyBudget: number; // major units
  @IsString() @MaxLength(60) optimizationGoal: string;
  @IsString() @MaxLength(60) billingEvent: string;
  @IsObject() targeting: Record<string, any>;
  @IsString() @MaxLength(2000) link: string;
  @IsString() @MaxLength(2000) primaryText: string;
  @IsString() @MaxLength(60) callToAction: string;
  @IsOptional() @IsBoolean() instagram?: boolean;
  @IsOptional() @IsIn(['PAUSED', 'ACTIVE']) status?: 'PAUSED' | 'ACTIVE';
}

/**
 * Ad reporting (GoHighLevel parity): each workspace connects its OWN Meta/TikTok
 * ad account (per-tenant sealed token) and reads aggregated spend/impressions/
 * clicks/leads. Connecting/removing/pulling is workspace config → MANAGER+ via
 * `settings.manage`, mirroring channel settings. Reading metrics is reporting →
 * `reports.read` (REP-capable, like the other reports). The sealed token is
 * never echoed back. `/status` reports which provider apps the platform has
 * configured (env-gated) so the UI can disable unavailable providers.
 */
@MarketingRoute()
@Controller('marketing/ads')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingAdsController {
  constructor(
    private readonly adAccounts: AdAccountService,
    private readonly adMgmt: AdManagementService,
  ) {}

  /** Which provider apps the platform has configured (global app creds). */
  @Get('status')
  @RequirePermission('reports.read')
  status() {
    return this.adAccounts.status();
  }

  /** Connected accounts for this workspace (no sealed token in the response). */
  @Get('accounts')
  @RequirePermission('reports.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.adAccounts.list(a.workspaceId);
  }

  /** Aggregated metrics over a date range (defaults to the trailing 30 days). */
  @Get('metrics')
  @RequirePermission('reports.read')
  metrics(@CurrentMarketingUser() a: MarketingUserPayload, @Query() q: AdMetricsQueryDto) {
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from =
      q.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    return this.adAccounts.getMetrics(a.workspaceId, from, to, q.provider);
  }

  @Post('accounts')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad_account.connect', resourceType: 'ad_account' })
  connect(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: ConnectAdAccountDto) {
    return this.adAccounts.connect(a.workspaceId, dto);
  }

  @Delete('accounts/:id')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad_account.disconnect', resourceType: 'ad_account' })
  remove(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.adAccounts.remove(a.workspaceId, id);
  }

  /** Manual on-demand refresh for one account (trailing `days`, default 7). */
  @Post('accounts/:id/pull')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  pull(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: PullAdAccountDto,
  ) {
    return this.adAccounts.pullNow(a.workspaceId, id, dto.days ?? 7);
  }

  // ── Campaign management (Meta write — needs ads_management) ───────────────

  /** Live campaigns for an account (budget in major units + status). */
  @Get('accounts/:id/campaigns')
  @RequirePermission('reports.read')
  campaigns(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.adMgmt.campaigns(a.workspaceId, id);
  }

  /** Live ad sets for an account (optionally filtered to one campaign). */
  @Get('accounts/:id/adsets')
  @RequirePermission('reports.read')
  adsets(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Query('campaignId') campaignId?: string,
  ) {
    return this.adMgmt.adsets(a.workspaceId, id, campaignId);
  }

  /** Set a campaign/adset daily budget (major units). */
  @Post('accounts/:id/entities/:entityId/budget')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad.budget.set', resourceType: 'ad_entity', resourceIdParam: 'entityId', captureBody: ['dailyBudget'] })
  setBudget(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Param('entityId') entityId: string,
    @Body() dto: SetBudgetDto,
  ) {
    return this.adMgmt.setDailyBudget(a.workspaceId, id, entityId, dto.dailyBudget);
  }

  /** Pause/resume a campaign or ad set. */
  @Post('accounts/:id/entities/:entityId/status')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad.status.set', resourceType: 'ad_entity', resourceIdParam: 'entityId', captureBody: ['status'] })
  setStatus(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Param('entityId') entityId: string,
    @Body() dto: SetStatusDto,
  ) {
    return this.adMgmt.setStatus(a.workspaceId, id, entityId, dto.status);
  }

  /** Deep-copy a campaign (leaves the copy PAUSED). */
  @Post('accounts/:id/campaigns/:campaignId/duplicate')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad.campaign.duplicate', resourceType: 'ad_entity', resourceIdParam: 'campaignId' })
  duplicate(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Param('campaignId') campaignId: string,
  ) {
    return this.adMgmt.duplicate(a.workspaceId, id, campaignId);
  }

  /** Create a campaign shell (PAUSED). Adset/ad/creative builder is a follow-up. */
  @Post('accounts/:id/campaigns')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad.campaign.create', resourceType: 'ad_entity', captureBody: ['name', 'objective'] })
  createCampaign(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: CreateAdCampaignDto,
  ) {
    return this.adMgmt.create(a.workspaceId, id, dto);
  }

  @Post('accounts/:id/launch')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'ad.launch', resourceType: 'ad_entity', captureBody: ['generatedAssetId', 'objective'] })
  launch(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: LaunchAdDto,
  ) {
    return this.adMgmt.launchAdFromCreative(a.workspaceId, id, dto);
  }
}
