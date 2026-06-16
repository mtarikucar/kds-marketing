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
import { KnowledgeService } from '../ai/knowledge.service';
import { AgentProfileService } from '../ai/agent-profile.service';
import { ContentAiService } from '../ai/content-ai.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { AskAiService } from '../ai/ask-ai.service';
import {
  CreateKnowledgeDto,
  UpdateKnowledgeDto,
  CreateAgentDto,
  UpdateAgentDto,
  ComposeContentDto,
  AskAiDto,
} from '../dto/ai.dto';

/**
 * AI surface for the workspace SPA: the Agent Studio knowledge base + agent
 * profiles (MANAGER-shaped config behind `agentStudio`), one-shot content
 * generation (`conversationAi`), and the read-only monthly credit meter that
 * powers the billing gauge. Every action is workspace-scoped through the
 * service layer; credit metering lives in ContentAiService/AiCreditsService.
 */
@MarketingRoute()
@Controller('marketing/ai')
@UseGuards(MarketingGuard, MarketingRolesGuard, FeatureGuard, PermissionsGuard)
export class MarketingAiController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly agents: AgentProfileService,
    private readonly content: ContentAiService,
    private readonly credits: AiCreditsService,
    private readonly askAi: AskAiService,
  ) {}

  // ---- Knowledge base (Agent Studio grounding docs) ----

  @Get('knowledge')
  @MarketingRoles('MANAGER')
  @RequiresFeature('agentStudio')
  listKnowledge(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.knowledge.list(actor.workspaceId);
  }

  @Get('knowledge/:id')
  @MarketingRoles('MANAGER')
  @RequiresFeature('agentStudio')
  getKnowledge(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.knowledge.get(actor.workspaceId, id);
  }

  @Post('knowledge')
  @MarketingRoles('MANAGER')
  @RequiresFeature('agentStudio')
  @RequirePermission('settings.manage')
  createKnowledge(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: CreateKnowledgeDto,
  ) {
    return this.knowledge.create(actor.workspaceId, dto);
  }

  @Patch('knowledge/:id')
  @MarketingRoles('MANAGER')
  @RequiresFeature('agentStudio')
  @RequirePermission('settings.manage')
  updateKnowledge(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateKnowledgeDto,
  ) {
    return this.knowledge.update(actor.workspaceId, id, dto);
  }

  @Delete('knowledge/:id')
  @MarketingRoles('MANAGER')
  @RequiresFeature('agentStudio')
  @RequirePermission('settings.manage')
  removeKnowledge(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.knowledge.remove(actor.workspaceId, id);
  }

  // ---- Agent profiles ----

  @Get('agents')
  @MarketingRoles('MANAGER')
  @RequiresFeature('agentStudio')
  listAgents(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.agents.list(actor.workspaceId);
  }

  @Get('agents/:id')
  @MarketingRoles('MANAGER')
  @RequiresFeature('agentStudio')
  getAgent(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.agents.get(actor.workspaceId, id);
  }

  @Post('agents')
  @MarketingRoles('MANAGER')
  @RequiresFeature('agentStudio')
  @RequirePermission('settings.manage')
  createAgent(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: CreateAgentDto,
  ) {
    return this.agents.create(actor.workspaceId, dto);
  }

  @Patch('agents/:id')
  @MarketingRoles('MANAGER')
  @RequiresFeature('agentStudio')
  @RequirePermission('settings.manage')
  updateAgent(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateAgentDto,
  ) {
    return this.agents.update(actor.workspaceId, id, dto);
  }

  @Delete('agents/:id')
  @MarketingRoles('MANAGER')
  @RequiresFeature('agentStudio')
  @RequirePermission('settings.manage')
  removeAgent(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Param('id') id: string,
  ) {
    return this.agents.remove(actor.workspaceId, id);
  }

  // ---- Content AI (copy generation) ----

  @Post('compose')
  @RequiresFeature('conversationAi')
  @RequirePermission('leads.write')
  compose(
    @CurrentMarketingUser() actor: MarketingUserPayload,
    @Body() dto: ComposeContentDto,
  ) {
    return this.content.compose(actor.workspaceId, dto);
  }

  // ---- Ask AI (read-only NL analyst over the workspace's data) ----

  @Post('ask')
  @RequiresFeature('askAi')
  @RequirePermission('leads.write')
  ask(@CurrentMarketingUser() actor: MarketingUserPayload, @Body() dto: AskAiDto) {
    return this.askAi.ask(actor.workspaceId, dto.question);
  }

  // ---- Credit meter (read-only; powers the billing gauge) ----

  @Get('usage')
  usage(@CurrentMarketingUser() actor: MarketingUserPayload) {
    return this.credits.usage(actor.workspaceId);
  }
}
