import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { APPLYING_HEARTBEAT_MS, ApprovalRequestService } from '../agents/approval-request.service';
import { AgentRunService } from '../agents/agent-run.service';
import { InvokeResult, McpBrokerService } from './mcp-broker.service';
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
 * Money-safety: an MCP tool call is not itself idempotent (send a message,
 * publish a post, push a spend change), so this does NOT execute-then-mark.
 * It claims the request (APPROVED -> APPLYING) via
 * `ApprovalRequestService.claimForApply` BEFORE invoking the tool — that
 * atomic claim is what makes two concurrent `apply()` calls at-most-once:
 * the loser is rejected at the claim, before touching the broker, instead of
 * after a duplicate send has already gone out. `markApplied` (used by
 * `BudgetExecutorService`) is a different, execute-then-mark contract for an
 * idempotent internal-plan commit and is untouched by this service.
 *
 * On tool success the claim is finished (APPLYING -> APPLIED). On tool
 * failure the claim is reverted (APPLYING -> APPROVED) so an operator can
 * retry, and the original error propagates untouched — never swallowed, and
 * the row is never left stranded in APPLYING.
 */
@Injectable()
export class McpApprovalExecutorService {
  private readonly logger = new Logger(McpApprovalExecutorService.name);

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

    // Atomic claim BEFORE executing anything: rejects a request that is not
    // APPROVED, and rejects a second concurrent caller racing this one (it
    // will see APPLYING, not APPROVED, and claim zero rows).
    await this.approvals.claimForApply(workspaceId, approvalId);

    const { tool: toolName, args } = payload;
    // Scopes: the approving human (settings.manage) has already authorised
    // this specific queued call; the original API-key caller's scopes aren't
    // available (or meaningful) at apply time, so the tool's own declared
    // scopes — the least-privilege set it was registered with — are what
    // this execution runs under.
    const grantedScopes = this.registry.get(toolName)?.scopes ?? [];

    // Heartbeat while the tool call is in flight (see
    // ApprovalRequestService.touchApplying/reapStaleApplying): a
    // multi-account or carousel publish can legitimately chain past any
    // fixed duration, so reapStaleApplying tells "still executing" apart
    // from "the process died" by liveness, not elapsed time. touchApplying
    // itself is best-effort and conditioned on status='APPLYING', so a
    // failed or late-arriving tick can never resurrect a row this method
    // has already moved out of APPLYING.
    //
    // The `finally` below guarantees this timer is cleared on every exit
    // path — success, a thrown tool error, a non-OK status, or even a throw
    // from finishApply/revertApply themselves — so it can never keep
    // beating past the execution it belongs to. A heartbeat that outlived
    // its call would recreate this bug from the other direction: a
    // genuinely-dead row kept looking alive forever.
    const heartbeat = setInterval(() => {
      this.approvals.touchApplying(workspaceId, approvalId).catch((e) => {
        this.logger.warn(`heartbeat write failed for approval ${approvalId}: ${(e as Error)?.message ?? e}`);
      });
    }, APPLYING_HEARTBEAT_MS);

    try {
      let invoked: InvokeResult;
      try {
        invoked = await this.runs.track(
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
      } catch (err) {
        // The tool failed — release the claim so the request goes back to
        // APPROVED (retryable) instead of being stranded in APPLYING, and
        // surface the original error untouched.
        await this.approvals.revertApply(workspaceId, approvalId);
        throw err;
      }

      if (invoked.status !== 'OK') {
        // Unreachable today — approvedBy always makes the broker execute
        // inline rather than re-enqueue — but never report APPLIED for
        // anything short of a real OK.
        await this.approvals.revertApply(workspaceId, approvalId);
        throw new BadRequestException(`tool call did not complete (status: ${invoked.status})`);
      }

      await this.approvals.finishApply(workspaceId, approvalId);

      return { status: 'APPLIED', result: invoked.result };
    } finally {
      clearInterval(heartbeat);
    }
  }
}
