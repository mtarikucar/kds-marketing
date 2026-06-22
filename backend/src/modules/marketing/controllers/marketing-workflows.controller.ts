import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { WorkflowsService } from '../workflows/workflows.service';
import {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  SetWorkflowStatusDto,
  DraftWorkflowDto,
} from '../dto/workflow.dto';

/**
 * Workflow automation surface. MANAGER+ behind the `workflows` feature. The
 * `draft` route (NL → DSL) is declared before the `:id` routes so the literal
 * wins. The DSL itself is validated in the service (Zod → 400 on bad shape).
 */
@MarketingRoute()
@Controller('marketing/workflows')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
@MarketingRoles('MANAGER')
@RequiresFeature('workflows')
export class MarketingWorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  list(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.workflows.list(actor.workspaceId);
  }

  /** Starter-template catalog for "Start from template". Read-only static
   *  recipes — declared before the `:id` routes so the literal path wins. */
  @Get('templates')
  templates() {
    return this.workflows.templates();
  }

  @Post('draft')
  @RequirePermission('automations.manage')
  draft(@CurrentMarketingUser() actor: MarketingUserPayload, @Body() dto: DraftWorkflowDto) {
    return this.workflows.draft(actor.workspaceId, dto.prompt);
  }

  @Post()
  @RequirePermission('automations.manage')
  create(@CurrentMarketingUser() actor: MarketingUserPayload, @Body() dto: CreateWorkflowDto) {
    return this.workflows.create(actor.workspaceId, dto);
  }

  @Get(':id')
  get(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.workflows.get(actor.workspaceId, id);
  }

  @Get(':id/runs')
  runs(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.workflows.runs(actor.workspaceId, id);
  }

  @Patch(':id')
  @RequirePermission('automations.manage')
  update(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateWorkflowDto,
  ) {
    return this.workflows.update(actor.workspaceId, id, dto);
  }

  @Post(':id/status')
  @RequirePermission('automations.manage')
  setStatus(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: SetWorkflowStatusDto,
  ) {
    return this.workflows.setStatus(actor.workspaceId, id, dto.status);
  }

  @Delete(':id')
  @RequirePermission('automations.manage')
  remove(@CurrentMarketingUser() actor: MarketingUserPayload, @Param('id') id: string) {
    return this.workflows.remove(actor.workspaceId, id);
  }
}
