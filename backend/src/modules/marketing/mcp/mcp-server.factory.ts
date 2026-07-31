import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  McpServer,
  type AuthInfo,
  type ListToolsResult,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import { McpToolRegistry } from './mcp-tool-registry';
import { McpInvokerService } from './mcp-invoker.service';

@Injectable()
export class McpServerFactoryService {
  constructor(
    private readonly registry: McpToolRegistry,
    private readonly invoker: McpInvokerService,
  ) {}

  /**
   * Builds a fresh McpServer for ONE request. Tools are registered against the
   * caller's granted scopes, so `tools/list` cannot even reveal the existence
   * of a tool this caller may not use.
   */
  build(ctx: McpRequestContext): McpServer {
    const authInfo = ctx.authInfo;
    if (!authInfo) throw new ForbiddenException('missing auth context');
    const scopes = authInfo.scopes ?? [];

    const server = new McpServer({ name: 'jeeta', version: '1.0.0' });
    const visible = this.registry.list(scopes);

    // EVERY scope-visible tool is registered — deferred ones included — so a
    // deferred tool is callable the instant a model has learned its name from
    // `jeeta.find_tools`. Deferral is an ADVERTISING decision, applied below on
    // `tools/list` alone; it is never a permission one.
    for (const meta of visible) {
      // inputSchema is REQUIRED here, not cosmetic: the SDK's registerTool picks
      // the handler's calling convention off its presence. Without it, the
      // callback is invoked as `(ctx)` instead of `(args, ctx)` — the caller's
      // real arguments are dropped and `ctx` (which carries the bearer
      // authInfo) is what our handler treats as `args`, which would then get
      // written into the ToolCallLog audit row. Do not remove this.
      server.registerTool(
        meta.name,
        { description: meta.description, inputSchema: meta.inputSchema },
        this.handlerFor(authInfo, meta.name),
      );
    }

    // Only when the SDK actually installed its tool handlers. `registerTool`
    // is what registers the `tools` capability (lazily, on the first call), and
    // `setRequestHandler` refuses a method the server declares no capability
    // for — so a caller whose scopes match NOTHING must be left exactly as it
    // was before: a server with no tool surface at all.
    if (visible.length) this.advertiseCoreOnly(server, scopes);

    return server;
  }

  /**
   * Progressive disclosure (design spec §3), as the installed SDK actually
   * permits it.
   *
   * ## Why not `RegisteredTool.disable()`
   * `@modelcontextprotocol/server@2` does expose `enable()`/`disable()`/
   * `remove()` plus `sendToolListChanged()`, and `capabilities.tools.listChanged`
   * is already true — but two facts rule that route out here:
   *
   *  1. A DISABLED tool is not merely hidden, it is uncallable: the SDK's
   *     `tools/call` handler rejects it with `Tool <name> disabled` (see
   *     `dist/mcp-*.mjs`, the `!tool.enabled` guard). So "hide it, then let
   *     `find_tools` re-enable it" needs the re-enable to survive to the NEXT
   *     request.
   *  2. It cannot. `McpController` wires `createMcpHandler((ctx) => this.factory
   *     .build(ctx))` — the per-request-factory model. A fresh `McpServer` is
   *     built for every HTTP request, so there is no session-scoped server to
   *     mutate and nothing to push a `notifications/tools/list_changed` down;
   *     an `enable()` from the `find_tools` request would be garbage-collected
   *     with the server that served it.
   *
   * ## What this does instead
   * Register everything (so every tool stays callable, statelessly, forever),
   * then replace the SDK's `tools/list` handler with one that emits only the
   * non-deferred core. `Protocol.setRequestHandler` overwrites by method —
   * `assertCanSetRequestHandler` is only consulted by the SDK's own one-time
   * `setToolRequestHandlers()`, which has already run by the time we get here —
   * so this is a supported override, not a monkey-patch of internals.
   *
   * The result is honest in both directions: the advertised list is genuinely
   * smaller, and a deferred tool found via `jeeta.find_tools` genuinely works
   * on the next call with no re-advertisement needed.
   */
  private advertiseCoreOnly(server: McpServer, scopes: string[]): void {
    server.server.setRequestHandler('tools/list', () => this.advertisedTools(server, scopes));
  }

  /**
   * The `tools/list` payload: the core (non-deferred) tools only.
   *
   * `toolInputSchemaJson` is the SDK's own memoized Zod→JSON-Schema conversion
   * — the exact bytes its stock `tools/list` would have emitted — so filtering
   * the list cannot drift from what the SDK advertises for the tools that
   * remain. Extracted as a method so the split is unit-testable without
   * standing up a transport.
   */
  advertisedTools(server: McpServer, scopes: string[]): ListToolsResult {
    return {
      tools: this.registry.listAdvertised(scopes).map((meta) => ({
        name: meta.name,
        description: meta.description,
        inputSchema: (server.toolInputSchemaJson(meta.name) ?? {
          type: 'object',
          properties: {},
        }) as ListToolsResult['tools'][number]['inputSchema'],
      })),
    };
  }

  /**
   * One tool handler. Extracted so it can be unit-tested directly.
   *
   * Two rules encoded here:
   *  - A broker refusal (missing scope, oversized args, unknown tool) becomes a
   *    structured `isError` result rather than a thrown exception, so the model
   *    can read the reason and correct itself instead of the whole request 500ing.
   *  - PENDING_APPROVAL is NOT an error. It is a successful outcome that happens
   *    to require a human, and the text says so explicitly so the model does not
   *    report the action as done.
   */
  handlerFor(authInfo: AuthInfo, toolName: string) {
    return async (args: Record<string, unknown>) => {
      try {
        const res = await this.invoker.invoke(authInfo, toolName, args ?? {});
        if (res.status === 'PENDING_APPROVAL') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Queued for human approval (approvalId: ${res.approvalId}). It has NOT been applied yet.`,
              },
            ],
          };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(res.result ?? null) }] };
      } catch (err) {
        const message = (err as { message?: string })?.message ?? String(err);
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    };
  }
}
