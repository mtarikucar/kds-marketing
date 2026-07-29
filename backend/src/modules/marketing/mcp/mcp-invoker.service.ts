import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { AgentRunService } from '../agents/agent-run.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { MembershipService } from '../services/membership.service';
import { InvokeResult, McpBrokerService } from './mcp-broker.service';

/**
 * The single call path for every MCP tool invocation.
 *
 * Its whole job is to make the audit trail unskippable: `McpBrokerService.log()`
 * silently writes nothing when `ctx.agentRunId` is absent, so we open an
 * AgentRun via `track()` FIRST and only then reach the broker. A tool call that
 * cannot be attributed to a run never executes.
 *
 * `runs.track()` awaits its own post-execution `agent_runs` UPDATE (inside
 * `finish()`) AFTER the broker call has already resolved — if that write
 * throws (DB failover, an unserialisable tool result), `track()` rethrows
 * even though the tool itself already ran. `McpServerFactoryService.handlerFor`
 * turns any thrown error into `isError: true`, which would invite the calling
 * model to retry a call whose side effect already landed (send a message
 * twice, publish twice, ...). So this method tracks whether the broker call
 * itself resolved OK and, if a LATER failure happens, returns that real
 * result instead of letting the bookkeeping failure masquerade as a failed
 * call — the failure is still logged, just through the server log rather
 * than the tool-call result.
 */
@Injectable()
export class McpInvokerService {
  private readonly logger = new Logger(McpInvokerService.name);

  constructor(
    private readonly broker: McpBrokerService,
    private readonly runs: AgentRunService,
    private readonly prisma: PrismaService,
    private readonly memberships: MembershipService,
  ) {}

  contextFrom(authInfo: AuthInfo): {
    workspaceId: string;
    userId?: string;
    grantedScopes: string[];
  } {
    const extra = authInfo.extra as { workspaceId?: string; userId?: string } | undefined;
    const workspaceId = extra?.workspaceId;
    if (!workspaceId) {
      throw new ForbiddenException('token is not bound to a workspace');
    }
    // `userId` is present only on the OAuth path (Faz 3) — an API key belongs
    // to a workspace, not a person, and must stay that way.
    return { workspaceId, userId: extra?.userId, grantedScopes: authInfo.scopes ?? [] };
  }

  /**
   * Faz 3 Task 8 — the real caller's role in THIS workspace.
   *
   * Resolved on every call rather than carried in the token: consent may have
   * happened weeks ago, and a demotion (MANAGER → REP) or a removal since then
   * has to bite immediately. The removal case is a REFUSAL, not a fallback to
   * the anonymous principal: an ex-member's connector must stop working
   * without anyone having to hunt down the tokens they were issued.
   */
  private async roleFor(userId: string, workspaceId: string): Promise<string> {
    const membership = await this.memberships.getActiveMembership(userId, workspaceId);
    if (!membership) {
      throw new ForbiddenException('the authorizing user is no longer an active member of this workspace');
    }
    return membership.role;
  }

  private async writeModeFor(workspaceId: string): Promise<'APPROVAL' | 'AUTONOMOUS'> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { mcpWriteMode: true },
    });
    return ws?.mcpWriteMode === 'AUTONOMOUS' ? 'AUTONOMOUS' : 'APPROVAL';
  }

  async invoke(authInfo: AuthInfo, toolName: string, args: Record<string, unknown>): Promise<InvokeResult> {
    const { workspaceId, userId, grantedScopes } = this.contextFrom(authInfo);
    const userRole = userId ? await this.roleFor(userId, workspaceId) : undefined;
    const writeMode = await this.writeModeFor(workspaceId);
    // Set only once the broker call resolves with a genuine OK — a
    // PENDING_APPROVAL result means nothing executed, so a later bookkeeping
    // failure there is still a real "did this happen?" unknown and must keep
    // propagating as an error, same as before.
    let toolRan = false;
    let toolResult: InvokeResult | undefined;
    try {
      return await this.runs.track(workspaceId, { agent: 'mcp', goal: toolName, input: args }, async (agentRunId) => {
        const result = await this.broker.invoke(
          { workspaceId, userId, userRole, grantedScopes, agentRunId, requireAudit: true, writeMode },
          toolName,
          args,
        );
        if (result.status === 'OK') {
          toolRan = true;
          toolResult = result;
        }
        return result;
      });
    } catch (err) {
      if (toolRan && toolResult) {
        this.logger.error(
          `tool ${toolName} (workspace ${workspaceId}) succeeded but post-execution run bookkeeping failed; ` +
            `reporting the real result, not an error: ${(err as Error)?.message ?? err}`,
        );
        return toolResult;
      }
      throw err;
    }
  }
}
