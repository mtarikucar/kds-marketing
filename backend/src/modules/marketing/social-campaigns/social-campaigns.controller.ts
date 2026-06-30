import {
  Body, Controller, Get, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString,
  ArrayMaxSize, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { SocialCampaignsService } from './social-campaigns.service';

const AUTOMATION = ['APPROVAL', 'SEMI_AUTO', 'FULL_AUTO'] as const;
const PLANNING = ['AI_PROPOSE', 'AI_FULL', 'USER_TOPICS'] as const;

class CadenceDto {
  @IsOptional() @IsInt() @Min(1) perWeek?: number;
  @IsArray() @IsInt({ each: true }) @ArrayMaxSize(7) daysOfWeek: number[];
  @IsString() @MaxLength(5) timeOfDay: string;
  @IsOptional() @IsString() @MaxLength(64) timezone?: string;
}

class CreateSocialCampaignDto {
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(500) goal?: string;
  @IsOptional() @IsString() @MaxLength(500) theme?: string;
  @IsObject() brief: Record<string, unknown>;
  @IsIn(AUTOMATION) automationMode: (typeof AUTOMATION)[number];
  @IsIn(PLANNING) planningMode: (typeof PLANNING)[number];
  @ValidateNested() @Type(() => CadenceDto) cadence: CadenceDto;
  @IsDateString() startDate: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) targetAccountIds: string[];
  @IsArray() @IsIn(['IMAGE', 'VIDEO'], { each: true }) @ArrayMaxSize(2) mediaKinds: string[];
  @IsOptional() @IsString() @MaxLength(200) defaultImageModel?: string;
  @IsOptional() @IsString() @MaxLength(200) defaultVideoModel?: string;
  @IsOptional() @IsInt() @Min(1) dailyPublishCap?: number;
  @IsOptional() @IsString() @MaxLength(100) linkedCampaignId?: string;
}

class UpdateSocialCampaignDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(500) goal?: string;
  @IsOptional() @IsString() @MaxLength(500) theme?: string;
  @IsOptional() @IsObject() brief?: Record<string, unknown>;
  @IsOptional() @IsIn(AUTOMATION) automationMode?: (typeof AUTOMATION)[number];
  @IsOptional() @IsIn(PLANNING) planningMode?: (typeof PLANNING)[number];
  @IsOptional() @ValidateNested() @Type(() => CadenceDto) cadence?: CadenceDto;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) targetAccountIds?: string[];
  @IsOptional() @IsArray() @IsIn(['IMAGE', 'VIDEO'], { each: true }) @ArrayMaxSize(2) mediaKinds?: string[];
  @IsOptional() @IsString() @MaxLength(200) defaultImageModel?: string;
  @IsOptional() @IsString() @MaxLength(200) defaultVideoModel?: string;
  @IsOptional() @IsInt() @Min(1) dailyPublishCap?: number;
  @IsOptional() @IsString() @MaxLength(100) linkedCampaignId?: string;
}

@MarketingRoute()
@Controller('marketing/social-campaigns')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('socialCampaigns')
export class SocialCampaignsController {
  constructor(private readonly svc: SocialCampaignsService) {}

  @Get()
  list(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.list(u.workspaceId);
  }

  @Post()
  @Audit({ action: 'social-campaign.create', resourceType: 'social-campaign', captureBody: ['name', 'automationMode', 'planningMode'] })
  @RequirePermission('campaigns.send')
  create(@Body() dto: CreateSocialCampaignDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.create(u.workspaceId, {
      ...dto,
      startDate: new Date(dto.startDate),
      endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      createdById: u.id,
    });
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.get(u.workspaceId, id);
  }

  @Patch(':id')
  @Audit({ action: 'social-campaign.update', resourceType: 'social-campaign', resourceIdParam: 'id' })
  @RequirePermission('campaigns.send')
  update(@Param('id') id: string, @Body() dto: UpdateSocialCampaignDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.update(u.workspaceId, id, {
      ...dto,
      startDate: dto.startDate ? new Date(dto.startDate) : undefined,
      endDate: dto.endDate ? new Date(dto.endDate) : undefined,
    } as any);
  }

  @Post(':id/activate')
  @Audit({ action: 'social-campaign.activate', resourceType: 'social-campaign', resourceIdParam: 'id' })
  @RequirePermission('campaigns.send')
  activate(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.activate(u.workspaceId, id);
  }

  @Post(':id/pause')
  @RequirePermission('campaigns.send')
  pause(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.pause(u.workspaceId, id);
  }

  @Post(':id/resume')
  @RequirePermission('campaigns.send')
  resume(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.resume(u.workspaceId, id);
  }

  @Post(':id/cancel')
  @Audit({ action: 'social-campaign.cancel', resourceType: 'social-campaign', resourceIdParam: 'id' })
  @RequirePermission('campaigns.send')
  cancel(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.cancel(u.workspaceId, id);
  }

  @Get(':id/items')
  listItems(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listItems(u.workspaceId, id);
  }

  @Post(':id/plan/confirm')
  @RequirePermission('campaigns.send')
  confirmPlan(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.confirmPlan(u.workspaceId, id);
  }

  @Post('items/:itemId/approve')
  @Audit({ action: 'social-campaign.item.approve', resourceType: 'social-campaign-item', resourceIdParam: 'itemId' })
  @RequirePermission('campaigns.send')
  approveItem(@Param('itemId') itemId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.approveItem(u.workspaceId, itemId);
  }

  @Post('items/:itemId/reject')
  @Audit({ action: 'social-campaign.item.reject', resourceType: 'social-campaign-item', resourceIdParam: 'itemId' })
  @RequirePermission('campaigns.send')
  rejectItem(@Param('itemId') itemId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.rejectItem(u.workspaceId, itemId);
  }

  @Post('items/:itemId/regenerate')
  @RequirePermission('campaigns.send')
  regenerateItem(@Param('itemId') itemId: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.regenerateItem(u.workspaceId, itemId);
  }
}
