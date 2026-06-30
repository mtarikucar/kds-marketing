import {
  Body, Controller, Delete, Get, Param, Post, Put, Query,
  UseGuards, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ArrayMaxSize, IsUrl,
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
import { MediaGenService } from '../ai/media/media-gen.service';
import { BrandKitService } from '../ai/media/brand-kit.service';

class GenerateDto {
  @IsIn(['IMAGE', 'VIDEO']) type: 'IMAGE' | 'VIDEO';
  @IsString() @MaxLength(2000) prompt: string;
  @IsOptional() @IsString() @MaxLength(200) model?: string;
  @IsOptional() @IsString() @MaxLength(1000) negativePrompt?: string;
  @IsOptional() @IsIn(['1:1', '9:16', '16:9', '4:5']) aspectRatio?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) durationSec?: number;
  @IsOptional() @IsArray() @IsUrl({}, { each: true }) @ArrayMaxSize(5) referenceImageUrls?: string[];
  @IsOptional() @IsInt() seed?: number;
}
class BrandKitDto {
  @IsOptional() @IsString() @MaxLength(1000) logoUrl?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(12) palette?: string[];
  @IsOptional() @IsString() @MaxLength(2000) tone?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) defaultHashtags?: string[];
  @IsOptional() @IsString() @MaxLength(300) defaultCta?: string;
}

@MarketingRoute()
@Controller('marketing')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('mediaGen')
export class MarketingMediaController {
  constructor(private readonly gen: MediaGenService, private readonly brand: BrandKitService) {}

  @Post('ai/media/generate')
  @RequirePermission('campaigns.send')
  generate(@Body() dto: GenerateDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.gen.requestGeneration(u.workspaceId, { ...dto, createdById: u.id });
  }

  @Get('ai/media/generations')
  list(
    @Query('type') type: string,
    @Query('status') status: string,
    @Query('campaignId') campaignId: string,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.gen.listAssets(u.workspaceId, { type, status, socialCampaignId: campaignId });
  }

  @Get('ai/media/generations/:id')
  getOne(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.gen.getAsset(u.workspaceId, id);
  }

  @Post('ai/media/generations/:id/regenerate')
  @RequirePermission('campaigns.send')
  regenerate(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.gen.regenerate(u.workspaceId, id, u.id);
  }

  @Delete('ai/media/generations/:id')
  @RequirePermission('campaigns.send')
  remove(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.gen.deleteAsset(u.workspaceId, id);
  }

  @Get('brand-kit')
  getBrandKit(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.brand.get(u.workspaceId);
  }

  @Put('brand-kit')
  @RequirePermission('campaigns.send')
  putBrandKit(@Body() dto: BrandKitDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.brand.upsert(u.workspaceId, dto);
  }

  @Post('brand-kit/reference-image')
  @RequirePermission('campaigns.send')
  @UseInterceptors(FileInterceptor('file'))
  addReference(@UploadedFile() file: any, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.brand.addReferenceImage(u.workspaceId, {
      originalname: file?.originalname, mimetype: file?.mimetype, buffer: file?.buffer, size: file?.size,
    });
  }
}
