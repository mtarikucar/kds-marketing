import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RequirePermission } from '../roles/require-permission.decorator';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { ApprovalRequestService } from '../agents/approval-request.service';
import { AgentRunService } from '../agents/agent-run.service';
import { McpApprovalExecutorService } from '../mcp/mcp-approval-executor.service';

/**
 * The human-in-the-loop surface for the multi-agent + Budget Autopilot stack:
 * the pending-approval queue (approve/reject high-risk money/publish/send
 * actions) and the agent-run audit trail. Decisions are MANAGER + audited.
 */
@MarketingRoute()
@Controller('marketing/approvals')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class MarketingApprovalsController {
  constructor(
    private readonly approvals: ApprovalRequestService,
    private readonly runs: AgentRunService,
    private readonly mcpExecutor: McpApprovalExecutorService,
  ) {}

  @Get()
  @RequirePermission('reports.read')
  pending(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.approvals.listPending(a.workspaceId);
  }

  @Post(':id/approve')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'approval.approve', resourceType: 'approval_request', resourceIdParam: 'id' })
  approve(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.approvals.approve(a.workspaceId, id, a.id);
  }

  @Post(':id/reject')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'approval.reject', resourceType: 'approval_request', resourceIdParam: 'id' })
  reject(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.approvals.reject(a.workspaceId, id, a.id);
  }

  // Apply an APPROVED MCP tool-call request: claims it (APPROVED -> APPLYING)
  // and runs it for real through McpBrokerService (mirrors budget's
  // reallocations/:approvalId/apply). Nothing an agent proposed touches the
  // outside world until a human hits this route.
  @Post(':id/apply')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  @Audit({ action: 'mcp.approval.apply', resourceType: 'approval_request', resourceIdParam: 'id' })
  apply(@CurrentMarketingUser() a: MarketingUserPayload, @Param('id') id: string) {
    return this.mcpExecutor.apply(a.workspaceId, id, a.id);
  }

  @Get('agent-runs')
  @RequirePermission('reports.read')
  agentRuns(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.runs.list(a.workspaceId);
  }
}
