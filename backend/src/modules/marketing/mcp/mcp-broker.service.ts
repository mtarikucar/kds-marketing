import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { McpTool, McpToolContext, McpToolRegistry } from './mcp-tool-registry';
import { ApprovalRequestService } from '../agents/approval-request.service';
import { AgentRunService } from '../agents/agent-run.service';

export interface InvokeResult {
  status: 'OK' | 'PENDING_APPROVAL';
  result?: unknown;
  approvalId?: string;
}

const MAX_ARGS_BYTES = 32 * 1024;

/**
 * The safe MCP broker (Faz 6) — the single choke point between an external agent
 * and Jeeta's internals. Enforces, in order: deny-by-default allow-list →
 * per-tenant scope (least privilege) → approval-gating for high-risk
 * (spend/publish/send) ops (which NEVER execute inline; they enqueue a human
 * approval) → argument-size sanitization → execution with a ToolCallLog audit
 * entry. This is the report's "AI → MCP Broker → internal API" boundary; tokens
 * and business logic stay behind it.
 */
@Injectable()
export class McpBrokerService {
  private readonly logger = new Logger(McpBrokerService.name);

  constructor(
    private readonly registry: McpToolRegistry,
    private readonly approvals: ApprovalRequestService,
    private readonly runs: AgentRunService,
  ) {}

  async invoke(ctx: McpToolContext, toolName: string, args: Record<string, unknown> = {}): Promise<InvokeResult> {
    const tool = this.registry.get(toolName);
    if (!tool) throw new NotFoundException(`unknown tool: ${toolName}`); // deny-by-default

    this.assertScopes(tool, ctx);
    this.assertArgsSize(args);

    // High-risk ops never execute inline — they enqueue a human approval.
    if (tool.requiresApproval) {
      const req = await this.approvals.enqueue(ctx.workspaceId, {
        kind: tool.approvalKind ?? 'AD_SPEND',
        summary: `MCP agent requested "${tool.name}"`,
        payload: { tool: tool.name, args },
        requestedByRunId: ctx.agentRunId,
      });
      return { status: 'PENDING_APPROVAL', approvalId: req.id };
    }

    const startedAt = Date.now();
    try {
      const result = await tool.handler(ctx, args);
      await this.log(ctx, tool, args, result, true, undefined, Date.now() - startedAt);
      return { status: 'OK', result };
    } catch (err) {
      await this.log(ctx, tool, args, undefined, false, String((err as Error)?.message ?? err), Date.now() - startedAt);
      throw err;
    }
  }

  private assertScopes(tool: McpTool, ctx: McpToolContext): void {
    const granted = new Set(ctx.grantedScopes ?? []);
    const missing = tool.scopes.filter((s) => !granted.has(s));
    if (missing.length) {
      throw new ForbiddenException(`missing scope(s): ${missing.join(', ')}`);
    }
  }

  private assertArgsSize(args: Record<string, unknown>): void {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(args ?? {}));
    } catch {
      throw new ForbiddenException('arguments are not serializable');
    }
    if (size > MAX_ARGS_BYTES) throw new ForbiddenException('arguments too large');
  }

  private async log(ctx: McpToolContext, tool: McpTool, args: unknown, result: unknown, ok: boolean, error: string | undefined, latencyMs: number): Promise<void> {
    if (!ctx.agentRunId) return; // logging is tied to an agent run
    try {
      await this.runs.recordTool(ctx.workspaceId, ctx.agentRunId, { tool: tool.name, args, result, ok, error, latencyMs });
    } catch (e) {
      this.logger.warn(`tool-call log failed for ${tool.name}: ${String((e as Error)?.message ?? e)}`);
    }
  }
}
