import { Injectable } from '@nestjs/common';

export type ToolRisk = 'READ' | 'WRITE' | 'SPEND';

export interface McpToolContext {
  workspaceId: string;
  userId?: string;
  grantedScopes: string[];
  agentRunId?: string;
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
