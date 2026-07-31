import { Injectable } from '@nestjs/common';
import { ZodObject, type ZodTypeAny } from 'zod';

/**
 * The risk vocabulary from the Faz 5 design spec (§4). `READ`/`WRITE`/`SPEND`
 * are the original three; `DESTRUCTIVE` arrived with D2's first delete tool.
 *
 * Only the classification is declared here — what it MEANS is enforced in one
 * place, `McpBrokerService`'s `ALWAYS_APPROVED_RISKS`: `SPEND` and
 * `DESTRUCTIVE` never execute inline, whatever the workspace's write mode.
 * The spec's `SEND`/`PUBLISH` rows are not separate members: they behave
 * exactly like `WRITE` at the gate (risky, but runnable unattended) and are
 * already distinguished for the human in the approval queue by `approvalKind`,
 * so adding them as risk values would be vocabulary without behaviour.
 */
export type ToolRisk = 'READ' | 'WRITE' | 'SPEND' | 'DESTRUCTIVE';

/**
 * The domain a tool belongs to (design spec §3: *"Tool'lar alan (domain) bazlı
 * gruplanır"*). This is the grouping key progressive disclosure works on: the
 * advertised surface keeps every domain's primary read and its common writes,
 * and `jeeta.find_tools` searches name + description + DOMAIN so a model that
 * knows only "something about calls" can find the deferred voice tools.
 *
 * Declared as a closed union (not a free string) so a typo becomes a compile
 * error instead of a domain nobody can search for, and pinned again at runtime
 * by `TOOL_DOMAINS` below because spec files are excluded from type-checking.
 */
export type ToolDomain =
  | 'analytics'
  | 'brand'
  | 'leads'
  | 'contacts'
  | 'tasks'
  | 'pipeline'
  | 'inbox'
  | 'campaigns'
  | 'email'
  | 'voice'
  | 'social'
  | 'content'
  | 'ads'
  | 'scheduling'
  | 'workspace'
  // Faz 5 D4 — the brain & automation wave. Three new domains rather than
  // folding them into existing ones: a model asking "what is our strategy?",
  // "what automations are running?" or "how do we find new prospects?" is
  // asking three different questions, and `jeeta.find_tools` matches on the
  // domain word itself.
  | 'strategy'
  | 'workflows'
  | 'research';

export const TOOL_DOMAINS: readonly ToolDomain[] = [
  'analytics',
  'brand',
  'leads',
  'contacts',
  'tasks',
  'pipeline',
  'inbox',
  'campaigns',
  'email',
  'voice',
  'social',
  'content',
  'ads',
  'scheduling',
  'workspace',
  'strategy',
  'workflows',
  'research',
] as const;

const DOMAIN_SET: ReadonlySet<string> = new Set<string>(TOOL_DOMAINS);

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
  /**
   * REQUIRED. The tool's domain — see `ToolDomain`. Enforced at runtime by
   * `register()` so a new tool cannot join the catalogue undiscoverable.
   */
  domain: ToolDomain;
  /**
   * When true this tool is NOT advertised in `tools/list`; it stays fully
   * registered and callable, and `jeeta.find_tools` is how a model discovers
   * it. Reserve this for niche/one-off tools — every domain's primary read and
   * its common writes must stay advertised, or the surface stops being usable
   * without a search on every turn. Defaults to false.
   */
  defer?: boolean;
  /** Scopes the caller must ALL hold (deny-by-default). */
  scopes: string[];
  risk: ToolRisk;
  /** When true, invoking enqueues an approval instead of executing. */
  requiresApproval: boolean;
  /** The kind used for the ApprovalRequest when gated. */
  approvalKind?:
    | 'BUDGET_REALLOCATION'
    | 'PUBLISH'
    | 'SEND'
    | 'AD_SPEND'
    | 'TARGET_CHANGE'
    | 'CHANNEL_LAUNCH'
    | 'MEDIA_SPEND'
    | 'DESTRUCTIVE'
    // Faz 5 D4 — see `ApprovalKind` in agents/approval-request.service.ts for
    // what each means. This union mirrors that one; a kind added there must be
    // added here too or no tool can declare it.
    | 'AI_SPEND'
    | 'STRATEGY_ACTION';
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
    if (!tool.domain || !DOMAIN_SET.has(tool.domain)) {
      // The progressive-disclosure tripwire (spec §3). A tool with no domain
      // is invisible to `jeeta.find_tools`'s domain match and cannot be
      // classified into the advertised core — if it were ALSO deferred it
      // would be unreachable in practice. Runtime guard, not just the
      // TypeScript `domain: ToolDomain` requirement, because spec files are
      // excluded from type-checking.
      throw new Error(
        `McpTool "${tool.name}" has an invalid domain (${String(tool.domain)}): every tool must declare one of ` +
          `${TOOL_DOMAINS.join(', ')} so progressive disclosure can group it and jeeta.find_tools can surface it.`,
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

  /**
   * The FULL scope-visible catalogue, sans handlers — every tool the caller
   * may call, deferred ones included. This is the set the transport registers
   * with the MCP SDK (so a deferred tool is callable the moment a model has
   * learned its name), and the set `jeeta.find_tools` searches.
   */
  list(grantedScopes: string[]): Array<Omit<McpTool, 'handler'>> {
    const granted = new Set(grantedScopes);
    return [...this.tools.values()]
      .filter((t) => t.scopes.every((s) => granted.has(s)))
      .map(({ handler, ...meta }) => meta);
  }

  /**
   * The ADVERTISED subset — what `tools/list` returns (spec §3). Deferred
   * tools are omitted here and only here: they remain registered, scope-checked
   * and callable, they are just not pushed into every model's context up front.
   */
  listAdvertised(grantedScopes: string[]): Array<Omit<McpTool, 'handler'>> {
    return this.list(grantedScopes).filter((t) => !t.defer);
  }

  /**
   * Free-text search over the scope-visible catalogue — the discovery half of
   * progressive disclosure. Matches name, description AND domain, so both
   * "call a customer" (description) and "voice" (domain) find
   * `jeeta.click_to_dial`. An empty query returns everything the caller may
   * see, which is the honest answer to "what can you do?".
   */
  search(grantedScopes: string[], query: string): Array<Omit<McpTool, 'handler'>> {
    const terms = String(query ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_.]+/i)
      .filter(Boolean);
    const all = this.list(grantedScopes);
    if (!terms.length) return all;
    const scored = all
      .map((tool) => {
        const haystack = `${tool.name} ${tool.domain} ${tool.description}`.toLowerCase();
        // Rank by how many of the caller's terms hit, so the best matches come
        // first when a model asks a multi-word question. Zero hits drops out.
        const hits = terms.filter((t) => haystack.includes(t)).length;
        return { tool, hits };
      })
      .filter((s) => s.hits > 0);
    scored.sort((a, b) => b.hits - a.hits || a.tool.name.localeCompare(b.tool.name));
    return scored.map((s) => s.tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
