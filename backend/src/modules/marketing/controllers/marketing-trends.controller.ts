import { Body, Controller, Get, Param, Post, UseGuards, NotFoundException } from '@nestjs/common';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { TrendRemixService } from '../trends/trend-remix.service';

class SceneDto {
  @IsString() @MaxLength(120) scene: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class SaveTemplateDto {
  @IsIn(['TIKTOK', 'INSTAGRAM', 'YOUTUBE']) sourcePlatform: 'TIKTOK' | 'INSTAGRAM' | 'YOUTUBE';
  @IsOptional() @IsString() @MaxLength(500) sourceUrl?: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) hookPattern?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SceneDto) sceneStructure?: SceneDto[];
  @IsOptional() @IsString() @MaxLength(500) pacingNote?: string;
  @IsOptional() @IsString() @MaxLength(500) captionPattern?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) riskScore?: number;
}

class BrandDto {
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(160) product?: string;
  @IsOptional() @IsString() @MaxLength(120) audience?: string;
  @IsOptional() @IsString() @MaxLength(60) tone?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) valueProps?: string[];
}

class RemixDto {
  @ValidateNested() @Type(() => BrandDto) brand: BrandDto;
}

/**
 * Trend → Remix (Faz 4). Stores ABSTRACT trend formats (never a copy) and
 * adapts them onto a brand. MANAGER-gated + audited. Trend extraction (Apify)
 * is the env-gated ingestion step; saving + remixing are live.
 */
@MarketingRoute()
@Controller('marketing/trends')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingTrendsController {
  constructor(
    private readonly trends: TrendRemixService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermission('reports.read')
  list(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.trends.list(a.workspaceId);
  }

  @Post()
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'trend.save', resourceType: 'trend_template', captureBody: ['sourcePlatform', 'title'] })
  save(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: SaveTemplateDto) {
    return this.trends.saveTemplate(a.workspaceId, dto);
  }

  @Post(':id/remix')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  async remix(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string, @Body() dto: RemixDto) {
    const template = await this.prisma.trendTemplate.findFirst({ where: { id, workspaceId: a.workspaceId } });
    if (!template) throw new NotFoundException('Trend template not found');
    return this.trends.buildRemixBrief(template, dto.brand);
  }
}
