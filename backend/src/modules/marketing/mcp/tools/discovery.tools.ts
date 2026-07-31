import { z } from 'zod';
import { McpToolRegistry, TOOL_DOMAINS } from '../mcp-tool-registry';

export interface DiscoveryToolDeps {
  registry: McpToolRegistry;
}

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
}
