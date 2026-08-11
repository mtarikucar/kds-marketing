import { z } from 'zod';
import { McpToolContext, McpToolRegistry, TOOL_DOMAINS } from '../mcp-tool-registry';
import { InvokeResult } from '../mcp-broker.service';

export interface DiscoveryToolDeps {
  registry: McpToolRegistry;
  /**
   * The broker's own `invoke`, passed as a function so this module never
   * imports the service that owns it. Every gate the broker applies keys off
   * the TARGET tool's registration, which is what makes `jeeta.call_tool` safe
   * — see the argument on its registration below.
   */
  dispatch: (
    ctx: McpToolContext,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<InvokeResult>;
}

/** This tool's own name, so it can refuse to invoke itself. */
const CALL_TOOL = 'jeeta.call_tool';

/**
 * Turns a tool's Zod `inputSchema` into the same JSON Schema `tools/list`
 * advertises, so a model that discovers a DEFERRED tool through
 * `jeeta.find_tools` can construct a correct call on its very next turn
 * instead of guessing argument names and burning a round-trip on a strict-mode
 * rejection.
 *
 * Failure is soft on purpose: an exotic schema that Zod cannot project to JSON
 * Schema must degrade to "here is the tool, ask it and read the error", never
 * take the whole discovery call down.
 */
function jsonSchemaOf(schema: unknown): unknown {
  try {
    return z.toJSONSchema(schema as never);
  } catch {
    return undefined;
  }
}

/**
 * Faz 5 D3 — progressive disclosure (design spec §3).
 *
 * The catalogue has outgrown what is safe to push into every model's context at
 * once, so the transport advertises a CORE surface (every domain's primary read
 * plus its common writes — see `McpToolRegistry.listAdvertised`) and this tool
 * is how everything else is reached. Deferred tools stay fully registered,
 * scope-checked and callable; they are simply not listed.
 *
 * `jeeta.find_tools` is therefore never itself deferred, and requires no scopes
 * at all: it can only ever reveal tools the caller ALREADY has the scopes for
 * (`McpToolRegistry.search` filters by `ctx.grantedScopes` exactly as `list`
 * does), so it discloses nothing a `tools/list` would not have.
 *
 * It is a pure catalogue read — it touches no tenant data — but it is still
 * given `ctx` by the broker like any other tool, and the scope filter it
 * applies comes from that context rather than from anything the caller passes.
 */
export function registerDiscoveryTools(registry: McpToolRegistry, deps: DiscoveryToolDeps): void {
  registry.register({
    name: 'jeeta.find_tools',
    description:
      'Search the FULL Jeeta tool catalogue by keyword, including tools that are not listed by default. ' +
      'Only a core subset of tools is advertised up front; everything else (niche reads, one-off setup ' +
      'calls, destructive actions) is reachable only after you find it here. Search by what you want to ' +
      // Deliberately does NOT enumerate the domains in prose: the `domain`
      // argument's enum already carries them into the advertised JSON schema,
      // and spelling them out here would make this tool match (and pollute)
      // every single domain-name query a model ever runs.
      'do ("call a customer", "delete a post", "audience segments"), or narrow to one area with the domain ' +
      'argument. Every result comes back with its JSON input schema, so you can call it directly by name afterwards — ' +
      'a tool being unlisted never means it is unavailable to you. Read-only.',
    domain: 'workspace',
    scopes: [],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      query: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Keywords to match against tool names, descriptions and domains. Omit to list the entire catalogue you have access to.',
        ),
      domain: z
        .enum(TOOL_DOMAINS as unknown as [string, ...string[]])
        .optional()
        .describe('Restrict results to a single domain.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe('Maximum tools to return (default 15, capped at 60).'),
    }),
    handler: async (ctx, args) => {
      const limit = typeof args.limit === 'number' ? args.limit : 15;
      const domain = typeof args.domain === 'string' ? args.domain : undefined;
      const matches = deps.registry
        .search(ctx.grantedScopes ?? [], typeof args.query === 'string' ? args.query : '')
        .filter((t) => (domain ? t.domain === domain : true));
      return {
        total: matches.length,
        returned: Math.min(matches.length, limit),
        tools: matches.slice(0, limit).map((t) => ({
          name: t.name,
          domain: t.domain,
          description: t.description,
          scopes: t.scopes,
          risk: t.risk,
          // Surfaced so a model can tell the user "this needs your approval"
          // BEFORE calling and getting a PENDING_APPROVAL back.
          requiresApproval: t.requiresApproval,
          listed: !t.defer,
          inputSchema: jsonSchemaOf(t.inputSchema),
        })),
      };
    },
  });

  /**
   * The other half of progressive disclosure — without which the first half
   * was a promise the transport could not keep.
   *
   * `find_tools` tells a model "a tool being unlisted never means it is
   * unavailable to you", and at the PROTOCOL level that was true: every tool
   * is registered, so a `tools/call` for a deferred name executes. But an MCP
   * CLIENT only ever issues `tools/call` for names it learned from
   * `tools/list`. A tool that is never listed is therefore unreachable in
   * every standard client, no matter what the catalogue says — the deferred
   * two-thirds of the surface (setup writes like `update_brand_profile`,
   * `create_research_profile`, `synthesize_strategy`) simply could not be
   * called. This tool closes that: one advertised entry point that can invoke
   * anything `find_tools` surfaced.
   *
   * ## Why this grants no authority
   * It is a dispatcher, not a bypass. `deps.dispatch` IS `McpBrokerService.
   * invoke`, and every gate there is resolved from the TARGET tool's own
   * registration, never from the caller's: `assertScopes(target, ctx)` against
   * the same granted scopes, the target's `requiresApproval` + risk against
   * the same `writeMode` (SPEND and DESTRUCTIVE stay gated in every mode), the
   * same arg-size limit, and the same audit row under the same `agentRunId`.
   * Invoking X through here is byte-for-byte as privileged as invoking X
   * directly — which is precisely the point, since X was already callable by
   * any client that happened to allow unlisted names.
   *
   * Consequently this tool declares NO scopes of its own. Requiring one would
   * be a second, wrong gate: a caller entitled to X would be refused X purely
   * for having reached it by name.
   */
  registry.register({
    name: CALL_TOOL,
    description:
      'Invoke any Jeeta tool by name, including the ones not listed by default. Use this to run a tool you ' +
      'discovered with jeeta.find_tools: pass its exact name and an input object matching the JSON schema that ' +
      'search returned. Permissions are unchanged — the tool you name is checked against your scopes, and if it ' +
      'needs human approval you get a pending approval back instead of an effect, exactly as calling it directly ' +
      'would. Prefer calling a listed tool directly; this is the door to everything else.',
    domain: 'workspace',
    scopes: [],
    // The wrapper itself neither reads nor writes; the target's own risk is
    // what the broker gates on. Classifying it higher would gate the DOOR
    // instead of the room and refuse reads that are plainly allowed.
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(120)
        .describe('Exact tool name to invoke, e.g. "jeeta.update_brand_profile" (from jeeta.find_tools).'),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("The target tool's arguments, matching the JSON schema jeeta.find_tools returned for it."),
    }),
    handler: async (ctx, args) => {
      const name = String(args.name ?? '').trim();
      // Refuse self-dispatch. Nesting buys nothing and an unbounded chain
      // would recurse until the stack (or the audit log) gives out.
      if (name === CALL_TOOL) {
        throw new Error(
          `${CALL_TOOL} cannot invoke itself — pass the name of the tool you actually want to run.`,
        );
      }
      const input = (args.input ?? {}) as Record<string, unknown>;
      const res = await deps.dispatch(ctx, name, input);

      // A PENDING_APPROVAL from the inner call is a VALUE here, not the
      // transport-level status the server factory inspects — so say so in the
      // payload itself. Returning the bare inner result would surface as a
      // plain success and read to the model as "done" when nothing ran.
      if (res.status === 'PENDING_APPROVAL') {
        return {
          tool: name,
          applied: false,
          status: 'PENDING_APPROVAL',
          approvalId: res.approvalId,
          message: `"${name}" requires human approval and has NOT been applied. Approval id: ${res.approvalId}.`,
        };
      }
      return { tool: name, applied: true, status: 'OK', result: res.result };
    },
  });
}
