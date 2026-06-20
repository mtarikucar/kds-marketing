import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
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
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { PipelinesService } from '../opportunities/pipelines.service';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import {
  CreatePipelineDto,
  UpdatePipelineDto,
  CreateStageDto,
  UpdateStageDto,
  ReorderStagesDto,
  CreateOpportunityDto,
  UpdateOpportunityDto,
  MoveOpportunityDto,
  LoseOpportunityDto,
  OpportunityFilterDto,
} from '../dto/opportunity.dto';

/**
 * Sales Opportunities + Pipelines (GoHighLevel parity).
 *
 * Reads/writes of opportunities require leads.read / leads.write — REP-capable,
 * and a REP is hard-scoped to their own deals in the service. Pipeline/stage
 * configuration is structural and gated on leads.manage (MANAGER+). Auth +
 * workspace context come from MarketingGuard.
 */
@Controller('marketing')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
@MarketingRoute()
export class MarketingOpportunitiesController {
  constructor(
    private readonly pipelines: PipelinesService,
    private readonly opportunities: OpportunitiesService,
  ) {}

  // ─── Pipelines (config — MANAGER+) ─────────────────────────────────────────
  @Get('pipelines')
  @RequirePermission('leads.read')
  listPipelines(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.pipelines.list(a.workspaceId);
  }

  @Get('pipelines/:id')
  @RequirePermission('leads.read')
  getPipeline(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.pipelines.get(a.workspaceId, id);
  }

  @Post('pipelines')
  @RequirePermission('leads.manage')
  @Audit({ action: 'pipeline.create', resourceType: 'pipeline', captureBody: ['name'] })
  createPipeline(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: CreatePipelineDto) {
    return this.pipelines.create(a.workspaceId, dto);
  }

  @Patch('pipelines/:id')
  @RequirePermission('leads.manage')
  updatePipeline(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdatePipelineDto,
  ) {
    return this.pipelines.update(a.workspaceId, id, dto);
  }

  @Delete('pipelines/:id')
  @RequirePermission('leads.manage')
  @Audit({ action: 'pipeline.delete', resourceType: 'pipeline' })
  removePipeline(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.pipelines.remove(a.workspaceId, id);
  }

  // ─── Stages (config — MANAGER+) ────────────────────────────────────────────
  @Post('pipelines/:id/stages')
  @RequirePermission('leads.manage')
  addStage(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: CreateStageDto,
  ) {
    return this.pipelines.addStage(a.workspaceId, id, dto);
  }

  @Patch('pipelines/:pid/stages/:sid')
  @RequirePermission('leads.manage')
  updateStage(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('pid') pid: string,
    @Param('sid') sid: string,
    @Body() dto: UpdateStageDto,
  ) {
    return this.pipelines.updateStage(a.workspaceId, pid, sid, dto);
  }

  @Delete('pipelines/:pid/stages/:sid')
  @RequirePermission('leads.manage')
  removeStage(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('pid') pid: string,
    @Param('sid') sid: string,
  ) {
    return this.pipelines.removeStage(a.workspaceId, pid, sid);
  }

  @Put('pipelines/:id/stages/reorder')
  @RequirePermission('leads.manage')
  reorderStages(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: ReorderStagesDto,
  ) {
    return this.pipelines.reorderStages(a.workspaceId, id, dto.stageIds);
  }

  // ─── Opportunities (REP-capable) ───────────────────────────────────────────
  @Get('opportunities')
  @RequirePermission('leads.read')
  listOpportunities(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Query() filter: OpportunityFilterDto,
  ) {
    return this.opportunities.list(a.workspaceId, filter, a);
  }

  @Get('opportunities/board')
  @RequirePermission('leads.read')
  board(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Query('pipelineId') pipelineId?: string,
  ) {
    return this.opportunities.board(a.workspaceId, pipelineId, a);
  }

  @Get('opportunities/:id')
  @RequirePermission('leads.read')
  getOpportunity(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.opportunities.get(a.workspaceId, id, a);
  }

  @Post('opportunities')
  @RequirePermission('leads.write')
  @Audit({ action: 'opportunity.create', resourceType: 'opportunity', captureBody: ['name'] })
  createOpportunity(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Body() dto: CreateOpportunityDto,
  ) {
    return this.opportunities.create(a.workspaceId, dto, a);
  }

  @Patch('opportunities/:id')
  @RequirePermission('leads.write')
  updateOpportunity(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateOpportunityDto,
  ) {
    return this.opportunities.update(a.workspaceId, id, dto, a);
  }

  @Post('opportunities/:id/move')
  @RequirePermission('leads.write')
  moveOpportunity(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: MoveOpportunityDto,
  ) {
    return this.opportunities.move(a.workspaceId, id, dto, a);
  }

  @Post('opportunities/:id/win')
  @RequirePermission('leads.write')
  @Audit({ action: 'opportunity.win', resourceType: 'opportunity' })
  winOpportunity(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.opportunities.win(a.workspaceId, id, a);
  }

  @Post('opportunities/:id/lost')
  @RequirePermission('leads.write')
  @Audit({ action: 'opportunity.lost', resourceType: 'opportunity' })
  loseOpportunity(
    @CurrentMarketingUser() a: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: LoseOpportunityDto,
  ) {
    return this.opportunities.lose(a.workspaceId, id, dto, a);
  }

  @Delete('opportunities/:id')
  @RequirePermission('leads.write')
  @Audit({ action: 'opportunity.delete', resourceType: 'opportunity' })
  removeOpportunity(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.opportunities.remove(a.workspaceId, id, a);
  }
}
