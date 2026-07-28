import { ForbiddenException, Injectable } from '@nestjs/common';
import { McpServer, type AuthInfo, type McpRequestContext } from '@modelcontextprotocol/server';
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

    const server = new McpServer({ name: 'jeeta', version: '1.0.0' });

    for (const meta of this.registry.list(authInfo.scopes ?? [])) {
      server.registerTool(meta.name, { description: meta.description }, this.handlerFor(authInfo, meta.name));
    }

    return server;
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
