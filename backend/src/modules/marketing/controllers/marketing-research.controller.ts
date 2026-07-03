import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { IsArray, ArrayNotEmpty, IsString, ArrayMaxSize, IsOptional } from 'class-validator';
import { MarketingResearchService } from '../services/marketing-research.service';
import { MarketingIngestTokensService } from '../services/marketing-ingest-tokens.service';
import { ResearchCandidateService } from '../research/research-candidate.service';
import { ResearchRunnerService } from '../research/research-runner.service';
import { ResearchSourcesService } from '../research/providers/research-sources.service';
import {
  CreateResearchProfileDto,
  UpdateResearchProfileDto,
  MintIngestTokenDto,
} from '../dto/research-profile.dto';

class CandidateIdsDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(200) @IsString({ each: true })
  ids: string[];
}
class CandidateQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() profileId?: string;
}
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingUserPayload } from '../types';

/**
 * Research settings surface: profiles (the routine's briefs), the daily
 * quota meter and ingest-token management. Workspace-shaping decisions, so
 * MANAGER+ only (OWNER passes via the hierarchical guard).
 */
@MarketingRoute()
@Controller('marketing/research')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
export class MarketingResearchController {
  constructor(
    private readonly research: MarketingResearchService,
    private readonly tokens: MarketingIngestTokensService,
    private readonly candidates: ResearchCandidateService,
    private readonly runner: ResearchRunnerService,
    private readonly sources: ResearchSourcesService,
  ) {}

  /** Whether the native research engine's source providers are configured. */
  @Get('status')
  status() {
    return this.sources.status();
  }

  // ---- Suggestions review queue ----

  @Get('candidates')
  listCandidates(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Query() q: CandidateQueryDto,
  ) {
    return this.candidates.list(actor.workspaceId, { status: q.status, profileId: q.profileId });
  }

  @Post('candidates/accept')
  @RequirePermission('leads.write')
  acceptCandidates(@CurrentMarketingUser() actor: MarketingUserPayload, @Body() dto: CandidateIdsDto) {
    return this.candidates.accept(actor.workspaceId, dto.ids);
  }

  @Post('candidates/reject')
  @RequirePermission('leads.write')
  rejectCandidates(@CurrentMarketingUser() actor: MarketingUserPayload, @Body() dto: CandidateIdsDto) {
    return this.candidates.reject(actor.workspaceId, dto.ids);
  }

  /** On-demand "Run now" for a profile — enqueues a research job. */
  @Post('profiles/:id/run')
  @RequirePermission('settings.manage')
  async runProfile(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    await this.runner.enqueueNow(actor.workspaceId, id);
    return { enqueued: true };
  }

  @Get('profiles')
  listProfiles(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.research.list(actor.workspaceId);
  }

  @Post('profiles')
  @RequirePermission('settings.manage')
  createProfile(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: CreateResearchProfileDto,
  ) {
    return this.research.create(actor.workspaceId, dto);
  }

  @Patch('profiles/:id')
  @RequirePermission('settings.manage')
  updateProfile(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateResearchProfileDto,
  ) {
    return this.research.update(actor.workspaceId, id, dto);
  }

  @Delete('profiles/:id')
  @RequirePermission('settings.manage')
  removeProfile(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.research.remove(actor.workspaceId, id);
  }

  @Get('usage')
  usage(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.research.usage(actor.workspaceId);
  }

  @Get('tokens')
  @RequiresFeature('apiAccess')
  listTokens(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.tokens.list(actor.workspaceId);
  }

  @Post('tokens')
  @RequiresFeature('apiAccess')
  @RequirePermission('settings.manage')
  mintToken(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: MintIngestTokenDto,
  ) {
    return this.tokens.mint(actor.workspaceId, dto.label);
  }

  @Delete('tokens/:id')
  @RequiresFeature('apiAccess')
  @RequirePermission('settings.manage')
  revokeToken(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.tokens.revoke(actor.workspaceId, id);
  }
}
