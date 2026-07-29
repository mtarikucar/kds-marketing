import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ApprovalRequestService } from '../agents/approval-request.service';
import { AgentRunService } from '../agents/agent-run.service';
import { McpBrokerService } from './mcp-broker.service';
import { McpToolRegistry } from './mcp-tool-registry';

interface McpApprovalPayload {
  tool: string;
  args: Record<string, unknown>;
}

/** True only for the `{ tool, args }` shape McpBrokerService.invoke() enqueues
 *  (mcp-broker.service.ts: `payload: { tool: tool.name, args }`). Anything
 *  else — e.g. a BUDGET_REALLOCATION's `{ budgetId, runId, after }` — is a
 *  different approval lane and must be rejected here, not executed. */
function isMcpPayload(payload: unknown): payload is McpApprovalPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.tool === 'string' &&
    p.tool.length > 0 &&
    typeof p.args === 'object' &&
    p.args !== null &&
    !Array.isArray(p.args)
  );
}

/**
 * The approve → EXECUTE capstone for MCP write tools (mirrors
 * BudgetExecutorService for the reallocation lane). An `ApprovalRequest`
 * enqueued by `McpBrokerService.invoke()` (payload `{ tool, args }`) sits
 * APPROVED-but-inert until this runs it for real.
 *
 * Ordering is money-safety critical: the tool executes FIRST, and only a
 * successful execution is followed by `markApplied`. `markApplied`'s atomic
 * `APPROVED -> APPLIED` claim (not a read-then-write check here) is what
 * prevents double execution — see its doc comment in approval-request.service.
 * If the tool throws, the request is left APPROVED so an operator can retry;
 * the error is never swallowed.
 */
@Injectable()
export class McpApprovalExecutorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalRequestService,
    private readonly broker: McpBrokerService,
    private readonly runs: AgentRunService,
    private readonly registry: McpToolRegistry,
  ) {}

  async apply(workspaceId: string, approvalId: string, userId: string): Promise<{ status: 'APPLIED'; result: unknown }> {
    const approval = await this.prisma.approvalRequest.findFirst({ where: { id: approvalId, workspaceId } });
    if (!approval) throw new NotFoundException('Approval request not found');

    const payload = approval.payload;
    if (!isMcpPayload(payload)) {
      throw new BadRequestException('Approval request is not an MCP tool invocation');
    }
    if (approval.status !== 'APPROVED') {
      throw new BadRequestException(`Request is ${approval.status}, not APPROVED`);
    }

    const { tool: toolName, args } = payload;
    // Scopes: the approving human (settings.manage) has already authorised
    // this specific queued call; the original API-key caller's scopes aren't
    // available (or meaningful) at apply time, so the tool's own declared
    // scopes — the least-privilege set it was registered with — are what
    // this execution runs under.
    const grantedScopes = this.registry.get(toolName)?.scopes ?? [];

    const invoked = await this.runs.track(
      workspaceId,
      { agent: 'mcp', goal: `apply approval ${approvalId}: ${toolName}` },
      (agentRunId) =>
        this.broker.invoke(
          {
            workspaceId,
            userId,
            grantedScopes,
            agentRunId,
            requireAudit: true,
            approvedBy: { approvalId, userId },
          },
          toolName,
          args,
        ),
    );

    // Tool ran successfully — only now claim the decision as applied.
    await this.approvals.markApplied(workspaceId, approvalId);

    return { status: 'APPLIED', result: invoked.result };
  }
}
