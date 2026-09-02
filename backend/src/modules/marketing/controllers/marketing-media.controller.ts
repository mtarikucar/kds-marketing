import {
  Body, Controller, Delete, Get, Param, Post, Put, Query,
  UseGuards, UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min,
  ArrayMaxSize, IsUrl,
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
import { GENERATED_ASSET_TYPES, GeneratedAssetType } from '../ai/media/media-asset.constants';
import { MEDIA_TECHNIQUES, listMediaModels } from '../ai/media/media-models.config';

/** Every aspect ratio any catalogued model offers. The per-model contract is
 *  what actually decides — the service rejects a ratio the chosen model does not
 *  publish — so this list only has to be the union, not a per-model gate. */
const ASPECT_RATIOS = [
  '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '9:21',
];

class GenerateDto {
  @IsIn([...GENERATED_ASSET_TYPES]) type: GeneratedAssetType;
  @IsString() @MaxLength(2000) prompt: string;
  @IsOptional() @IsString() @MaxLength(200) model?: string;
  @IsOptional() @IsString() @MaxLength(1000) negativePrompt?: string;
  @IsOptional() @IsIn(ASPECT_RATIOS) aspectRatio?: string;
  // Free-form on purpose: the values are per-model wire strings whose casing is
  // load-bearing ('4k' vs '4K' vs '1024x1024'). The service validates the value
  // against the chosen model's contract, which is the only correct gate.
  @IsOptional() @IsString() @MaxLength(20) resolution?: string;
  // 60s is the AUDIO ceiling; video is clamped to MEDIA_GEN_MAX_VIDEO_SEC (10)
  // inside the service, so a longer value here cannot buy a longer clip.
  @IsOptional() @IsInt() @Min(1) @Max(60) durationSec?: number;
  // There is deliberately no sourceDurationSec/sourceWidth/sourceHeight here.
  // A property of the caller's FILE, stated in the request body, is the payer
  // stating their own bill — `sourceDurationSec: 0.1` on a ten-minute clip
  // reserves one credit against a $96 render — and the endpoints priced that
  // way report nothing back that a true-up could correct. The models in that
  // position are withheld from the catalogue instead, until the server can
  // measure the file itself.
  @IsOptional() @IsBoolean() generateAudio?: boolean;
  // 14 is the largest reference set any catalogued model takes (Nano Banana Pro
  // edit); each model's own contract trims the list to its own cap.
  @IsOptional() @IsArray() @IsUrl({}, { each: true }) @ArrayMaxSize(14) referenceImageUrls?: string[];
  @IsOptional() @IsUrl() @MaxLength(2000) lastImageUrl?: string;
  @IsOptional() @IsUrl() @MaxLength(2000) videoUrl?: string;
  @IsOptional() @IsUrl() @MaxLength(2000) audioUrl?: string;
  @IsOptional() @IsUrl() @MaxLength(2000) maskUrl?: string;
  @IsOptional() @IsString() @MaxLength(100) voice?: string;
  @IsOptional() @IsString() @MaxLength(20) language?: string;
  @IsOptional() @IsString() @MaxLength(100) avatar?: string;
  @IsOptional() @IsInt() seed?: number;
}
class BrandKitDto {
  @IsOptional() @IsString() @MaxLength(1000) logoUrl?: string;
  @IsOptional() @IsString() @MaxLength(500) logoR2Key?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(12) palette?: string[];
  @IsOptional() @IsString() @MaxLength(2000) tone?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) defaultHashtags?: string[];
  @IsOptional() @IsString() @MaxLength(300) defaultCta?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(5) referenceImages?: Array<{ url: string; r2Key?: string; mime?: string }>;
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

  /** The technique-organised catalogue the studio UI is built from. Serving it
   *  from the same module that prices and validates a generation is what keeps
   *  the picker from drifting away from the contract behind it.
   *
   *  `listMediaModels()` — not the raw record — because a WITHHELD model must
   *  not be offered: it stays catalogued (verified id, contract, published
   *  pricing, and the live endpoint probe still walks it) but is not for sale,
   *  and the service refuses it too, so the two ends agree. The technique list
   *  is unfiltered on purpose; the studio already drops any technique no served
   *  model sits under, so a technique that empties out simply stops appearing
   *  rather than needing a second list to be kept in step. */
  @Get('ai/media/models')
  models() {
    return {
      techniques: MEDIA_TECHNIQUES,
      models: listMediaModels().map((m) => ({
        id: m.id,
        technique: m.technique,
        type: m.type,
        label: m.label,
        credits: m.credits,
        creditsPerSec: m.creditsPerSec,
        creditsPerKChar: m.creditsPerKChar,
        creditsPerMinute: m.creditsPerMinute,
        tiers: m.tiers,
        // The picker needs the contract to know which controls to render at all.
        contract: m.contract,
        note: m.note,
      })),
    };
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
