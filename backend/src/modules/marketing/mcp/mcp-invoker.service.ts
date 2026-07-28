import { ForbiddenException, Injectable } from '@nestjs/common';
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
 */
@Injectable()
export class McpInvokerService {
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
    return this.runs.track(workspaceId, { agent: 'mcp', goal: toolName, input: args }, (agentRunId) =>
      this.broker.invoke({ workspaceId, grantedScopes, agentRunId, requireAudit: true, writeMode }, toolName, args),
    );
  }
}
