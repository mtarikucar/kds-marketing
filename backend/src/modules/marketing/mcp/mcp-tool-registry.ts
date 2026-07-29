import { Injectable } from '@nestjs/common';
import type { ZodTypeAny } from 'zod';

export type ToolRisk = 'READ' | 'WRITE' | 'SPEND';

export interface McpToolContext {
  workspaceId: string;
  userId?: string;
  grantedScopes: string[];
  agentRunId?: string;
  /**
   * Set by callers that MUST be auditable (the MCP transport). When true, a
   * call without `agentRunId` is refused rather than executed unlogged.
   */
  requireAudit?: boolean;
  /** Per-workspace MCP write policy. Unset behaves as 'APPROVAL'. */
  writeMode?: 'APPROVAL' | 'AUTONOMOUS';
  /**
   * Set only by the approval executor once a human has approved a pending
   * request. Records who authorised the call so an approved execution stays
   * distinguishable from an AUTONOMOUS one in the audit trail.
   */
  approvedBy?: { approvalId: string; userId: string };
}

export interface McpTool {
  name: string;
  description: string;
  /** Scopes the caller must ALL hold (deny-by-default). */
  scopes: string[];
  risk: ToolRisk;
  /** When true, invoking enqueues an approval instead of executing. */
  requiresApproval: boolean;
  /** The kind used for the ApprovalRequest when gated. */
  approvalKind?: 'BUDGET_REALLOCATION' | 'PUBLISH' | 'SEND' | 'AD_SPEND' | 'TARGET_CHANGE' | 'CHANNEL_LAUNCH';
  /**
   * REQUIRED. The MCP SDK's `registerTool` dispatches the callback with
   * `(ctx)` instead of `(args, ctx)` when no `inputSchema` is given — see
   * `McpServerFactoryService.build()` for why that is unsafe here, not just
   * wrong. Every tool must declare its arguments, even a tool that takes none
   * (use `z.object({})`).
   */
  inputSchema: ZodTypeAny;
  handler: (ctx: McpToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The curated allow-list of Jeeta tools exposed to external agents via MCP
 * (Faz 6). Nothing is callable unless it is explicitly registered here — the
 * deny-by-default surface the report mandates. Tools declare the scopes they
 * require and whether they are high-risk (approval-gated). The transport (MCP
 * server) is a thin layer over this registry; policy lives in the broker.
 */
@Injectable()
export class McpToolRegistry {
  private readonly tools = new Map<string, McpTool>();

  register(tool: McpTool): void {
    if (!tool.inputSchema) {
      // See the McpTool.inputSchema doc comment: without a schema the MCP
      // SDK's registerTool calls the handler as `(ctx)` instead of
      // `(args, ctx)`, silently dropping the caller's real arguments and
      // passing ServerContext — which carries the bearer token — in their
      // place, where it then lands in the ToolCallLog.args audit column.
      // Spec files are excluded from type-checking, so this must be a
      // runtime guard, not just the TypeScript `inputSchema: ZodTypeAny`
      // requirement.
      throw new Error(
        `McpTool "${tool.name}" is missing inputSchema: registering it without one causes the MCP SDK to invoke ` +
          'the handler with ServerContext (bearer token included) in place of the caller\'s arguments, which then ' +
          'gets written into the ToolCallLog audit column. Declare inputSchema (use z.object({}) for no-arg tools).',
      );
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): McpTool | undefined {
    return this.tools.get(name);
  }

  /** List tools the caller is allowed to see (scope-visible), sans handlers. */
  list(grantedScopes: string[]): Array<Omit<McpTool, 'handler'>> {
    const granted = new Set(grantedScopes);
    return [...this.tools.values()]
      .filter((t) => t.scopes.every((s) => granted.has(s)))
      .map(({ handler, ...meta }) => meta);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
