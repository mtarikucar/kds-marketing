import { Body, Controller, Get, Post, Put, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { BrandBrainService } from '../brand-brain/brand-brain.service';
import { BrandProfileService } from '../brand-brain/brand-profile.service';
import { BrandProfilePayload } from '../dto/brand-profile.dto';

class SearchDto {
  @IsString() @MaxLength(300) query: string;
  @IsOptional() @IsInt() @Min(1) @Max(20) k?: number;
}

/**
 * Brand Brain (Faz 1) — source-grounded, CITED retrieval over the workspace's
 * knowledge docs. Search is keyword+citation today; semantic re-rank lights up
 * once an embedding provider is configured (no API change). Reindex rebuilds the
 * chunk index from the knowledge base.
 */
@MarketingRoute()
@Controller('marketing/brand-brain')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingBrandBrainController {
  constructor(
    private readonly brain: BrandBrainService,
    private readonly profiles: BrandProfileService,
  ) {}

  @Post('search')
  @RequirePermission('reports.read')
  search(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: SearchDto) {
    return this.brain.search(a.workspaceId, { queryText: dto.query, k: dto.k ?? 5 });
  }

  @Post('reindex')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'brand_brain.reindex', resourceType: 'knowledge_base' })
  reindex(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.brain.reindexWorkspace(a.workspaceId);
  }

  // No @RequirePermission — PermissionsGuard allows-when-absent (opt-in
  // gate; see roles/permissions.guard.ts), so this stays readable by any
  // authenticated marketing user of the workspace, same as before Epic F
  // permissions existed on this controller.
  @Get('profile')
  getProfile(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.profiles.get(a.workspaceId);
  }

  @Put('profile')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'brand_brain.profile.update', resourceType: 'brand_profile' })
  putProfile(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: BrandProfilePayload) {
    return this.profiles.upsert(a.workspaceId, dto);
  }
}
