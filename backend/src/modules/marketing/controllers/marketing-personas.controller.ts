import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { VideoPersonaService } from '../video/video-persona.service';
import { VideoPipelineService, VideoModel } from '../video/video-pipeline.service';

class CreatePersonaDto {
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) referenceImageUrls?: string[];
  @IsOptional() @IsInt() lockedSeed?: number;
  @IsOptional() @IsString() @MaxLength(120) voiceId?: string;
}

class BriefDto {
  @IsString() @MaxLength(160) product: string;
  @IsOptional() @IsString() @MaxLength(200) hook?: string;
  @IsOptional() @IsString() @MaxLength(200) offer?: string;
  @IsOptional() @IsIn([15, 30, 45]) durationSec?: 15 | 30 | 45;
  @IsOptional() @IsString() @MaxLength(60) tone?: string;
  @IsOptional() @IsString() @MaxLength(120) audience?: string;
}

class PlanShotsDto {
  @ValidateNested() @Type(() => BriefDto) brief: BriefDto;
  @IsOptional() @IsIn(['seedance', 'veo', 'kling', 'higgsfield']) model?: VideoModel;
  @IsOptional() @IsString() personaId?: string;
}

/**
 * UGC persona library + shot-plan preview (Faz 2). Personas are the identity
 * anchor for consistent multi-shot video; `plan` returns the per-shot generation
 * plan (pure) the video executor will consume. MANAGER-gated + audited.
 */
@MarketingRoute()
@Controller('marketing/personas')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingPersonasController {
  constructor(
    private readonly personas: VideoPersonaService,
    private readonly pipeline: VideoPipelineService,
  ) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.personas.list(a.workspaceId);
  }

  @Post()
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'persona.create', resourceType: 'video_persona', captureBody: ['name'] })
  create(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreatePersonaDto) {
    return this.personas.create(a.workspaceId, dto);
  }

  @Get(':id')
  @RequirePermission('reports.read')
  get(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.personas.get(a.workspaceId, id);
  }

  @Post('plan')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  async plan(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: PlanShotsDto) {
    const persona = dto.personaId ? await this.personas.get(a.workspaceId, dto.personaId) : undefined;
    return this.pipeline.planShots(
      dto.brief,
      dto.model ?? 'seedance',
      persona ? { name: persona.name, referenceImageUrls: persona.referenceImageUrls, lockedSeed: persona.lockedSeed } : undefined,
    );
  }
}
