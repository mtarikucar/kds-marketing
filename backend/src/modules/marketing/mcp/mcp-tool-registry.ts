import { Injectable } from '@nestjs/common';
import { ZodObject, type ZodTypeAny } from 'zod';

export type ToolRisk = 'READ' | 'WRITE' | 'SPEND';

export interface McpToolContext {
  workspaceId: string;
  /**
   * The human behind the call, when there IS one. Present on an OAuth session
   * (the user who consented) and on an approved execution (the approver);
   * absent on an API-key session, which belongs to a workspace, not a person.
   */
  userId?: string;
  /**
   * The role `userId` holds in THIS workspace, resolved from their ACTIVE
   * membership at call time — not read off the token, so a demotion or removal
   * since consent takes effect on the very next call. Only meaningful
   * alongside `userId`; tools that apply row-level visibility fall back to
   * their declared service principal when both are absent.
   */
  userRole?: string;
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
   * Only meaningful when `requiresApproval` is true. `resourceType` is a
   * fixed label for what this tool acts on (e.g. `'conversation'`,
   * `'social_post'`); `resourceIdFrom` pulls the stable identifier of the
   * SPECIFIC target out of the caller's own args (e.g. `conversationId`).
   * Together they let `McpBrokerService.invoke()` recognise "this is the same
   * target as an already-pending request" and supersede the stale duplicate
   * instead of leaving two visually-identical approval cards live — see
   * `BudgetAutopilotService.propose()`'s supersede sweep, which this mirrors.
   * Omit both on a tool with no natural single-resource target.
   */
  resourceType?: string;
  resourceIdFrom?: (args: Record<string, unknown>) => string | undefined;
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
    // Reject unknown arguments instead of dropping them. Zod objects are
    // permissive by default: an argument the schema does not declare is
    // stripped and the call proceeds as if it had never been passed. On a
    // model-facing surface that failure is silent and wrong in the worst
    // direction — `search_leads({query: "Acme"})` (the caller meant `search`)
    // parses to `{}` and returns the whole unfiltered list, which reads to the
    // agent as "these are the Acme leads". Strict turns that into a visible
    // error the model can correct on the next call. Applied centrally so a
    // tool author cannot forget it; required fields already covered the
    // write tools, so this closes the gap on optional filters.
    const schema = tool.inputSchema;
    const strict = schema instanceof ZodObject ? schema.strict() : schema;
    this.tools.set(tool.name, { ...tool, inputSchema: strict });
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
