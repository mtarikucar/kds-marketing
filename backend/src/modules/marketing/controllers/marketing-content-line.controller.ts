import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { Audit } from '../../audit/audit.decorator';
import { MarketingUserPayload } from '../types';
import { ContentLineService, MAX_BATCH_LIMIT } from '../content-concepts/content-line.service';
import { AnglePerformanceService } from '../content-concepts/angle-performance.service';
import { ContentConceptsService } from '../content-concepts/content-concepts.service';

class ListBatchesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_BATCH_LIMIT)
  limit?: number;
}

class PlanDto {
  @IsString()
  @MaxLength(8000)
  idea!: string;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(8)
  count?: number;

  @IsOptional()
  @IsString()
  socialCampaignId?: string;

  @IsOptional()
  @IsString()
  personaId?: string;

  /**
   * Angle weights set by hand, replacing the measured ones for this batch.
   *
   * Deliberately unvalidated beyond "an object": the angle taxonomy is a prompt,
   * not an enum — `concept-distinctness.ts` exists precisely so the sixth good
   * angle can be invented — and a whitelist here would forbid weighting an angle
   * the model is still free to produce.
   */
  @IsOptional()
  @IsObject()
  angleWeights?: Record<string, number>;
}

/**
 * The Growth Studio hub's data. Concepts have been reachable ONLY through MCP
 * since they shipped, which is why the content line had no home in the panel:
 * the batch existed in the database and in the chat, and nowhere a person could
 * look. These four endpoints are that home.
 *
 * Reads take `campaigns.read`; planning takes `campaigns.write` and is audited,
 * because it spends AI and media credits. No new permission is invented — the
 * line is campaign work and is governed as campaign work.
 */
@MarketingRoute()
@Controller('marketing/content-line')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('socialCampaigns')
export class MarketingContentLineController {
  constructor(
    private readonly line: ContentLineService,
    private readonly anglePerformance: AnglePerformanceService,
    private readonly concepts: ContentConceptsService,
  ) {}

  /** One card per idea: what was proposed, made, published, and earned. */
  @Get('batches')
  @RequirePermission('campaigns.read')
  batches(@CurrentMarketingUser() user: MarketingUserPayload, @Query() q: ListBatchesDto) {
    return this.line.batches(user.workspaceId, q.limit);
  }

  /**
   * What the line has learned. Separate from `batches` so the hub can render the
   * cards when this fails and say WHICH panel is missing, rather than showing an
   * empty studio because one query broke.
   */
  @Get('angles')
  @RequirePermission('campaigns.read')
  angles(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.anglePerformance.byAngle(user.workspaceId);
  }

  /**
   * Literal segments are declared before `:batchId` would be, and there is no
   * `:batchId` route on this controller at all — the batch's concepts are read
   * through the existing concept list, which already filters by `batchId`.
   * Adding a second way to read the same rows is the duplication this surface
   * exists to avoid.
   */
  @Get('batches/:batchId')
  @RequirePermission('campaigns.read')
  batch(@CurrentMarketingUser() user: MarketingUserPayload, @Param('batchId') batchId: string) {
    return this.concepts.list(user.workspaceId, { batchId });
  }

  @Post('plan')
  @RequirePermission('campaigns.write')
  @Audit({ action: 'content.line.plan', resourceType: 'content_concept_batch' })
  plan(@CurrentMarketingUser() user: MarketingUserPayload, @Body() body: PlanDto) {
    return this.concepts.planConcepts(user.workspaceId, {
      idea: body.idea,
      count: body.count,
      socialCampaignId: body.socialCampaignId,
      personaId: body.personaId,
      angleWeights: body.angleWeights,
      createdById: user.id,
    });
  }
}
