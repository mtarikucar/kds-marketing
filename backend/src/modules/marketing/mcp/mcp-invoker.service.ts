import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { AgentRunService } from '../agents/agent-run.service';
import { PrismaService } from '../../../prisma/prisma.service';
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
  ) {}

  contextFrom(authInfo: AuthInfo): { workspaceId: string; grantedScopes: string[] } {
    const workspaceId = (authInfo.extra as { workspaceId?: string } | undefined)?.workspaceId;
    if (!workspaceId) {
      throw new ForbiddenException('token is not bound to a workspace');
    }
    return { workspaceId, grantedScopes: authInfo.scopes ?? [] };
  }

  private async writeModeFor(workspaceId: string): Promise<'APPROVAL' | 'AUTONOMOUS'> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { mcpWriteMode: true },
    });
    return ws?.mcpWriteMode === 'AUTONOMOUS' ? 'AUTONOMOUS' : 'APPROVAL';
  }

  async invoke(authInfo: AuthInfo, toolName: string, args: Record<string, unknown>): Promise<InvokeResult> {
    const { workspaceId, grantedScopes } = this.contextFrom(authInfo);
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
          { workspaceId, grantedScopes, agentRunId, requireAudit: true, writeMode },
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
