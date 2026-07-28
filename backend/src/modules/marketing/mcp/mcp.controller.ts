import { Controller, OnModuleDestroy, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { createMcpHandler, OAuthError, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server';
import { McpServerFactoryService } from './mcp-server.factory';
import { McpTokenVerifierService } from './mcp-token-verifier.service';

/**
 * The MCP Streamable-HTTP endpoint. Served at POST /api/mcp (the global
 * `api` prefix from app.config.ts applies on top of the `mcp` route below).
 *
 * `createMcpHandler` verifies nothing — `authInfo` is strictly pass-through —
 * so the bearer token is verified HERE and the resulting AuthInfo is handed to
 * the handler explicitly.
 */
@Controller('mcp')
export class McpController implements OnModuleDestroy {
  private readonly handler: McpHttpHandler;

  constructor(
    private readonly factory: McpServerFactoryService,
    private readonly verifier: McpTokenVerifierService,
  ) {
    this.handler = createMcpHandler((ctx) => this.factory.build(ctx));
  }

  /**
   * `McpHttpHandler.close()` tears down the modern leg: it aborts in-flight
   * modern exchanges (including any open `subscriptions/listen` SSE stream)
   * and closes their per-request instances. Without calling it on shutdown,
   * a streaming response would keep its transport (and the process) from
   * draining cleanly.
   */
  async onModuleDestroy(): Promise<void> {
    await this.handler.close();
  }

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const authz = req.headers?.authorization;
    // RFC 7235 §2.1: the auth-scheme token ("Bearer") is case-insensitive.
    const match = typeof authz === 'string' ? /^bearer\s+(.+)$/i.exec(authz) : null;
    const token = match ? match[1].trim() : null;

    if (!token) {
      this.missingCredential(res);
      return;
    }

    let authInfo: AuthInfo;
    try {
      authInfo = await this.verifier.verifyAccessToken(token);
    } catch (err) {
      // Only a rejected/invalid token is a 401. Anything else (a database
      // outage, a bug) is a real 500 — telling the caller to re-mint a key
      // that was never the problem would hide the actual failure.
      if (!(err instanceof OAuthError)) {
        throw err;
      }
      this.invalidToken(res, err.message);
      return;
    }

    // `parsedBody` lets the SDK skip re-reading the request body: `req.body`
    // is already the parsed object (app.config.ts's global bodyParser.json()
    // has already run), so this also avoids a stale copied `content-length`
    // that a re-stringified body could no longer match.
    const response = await this.handler.fetch(this.toFetchRequest(req), { authInfo, parsedBody: req.body });
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (!response.body) {
      res.end();
      return;
    }

    // Stream the body through rather than buffering it: an open
    // `subscriptions/listen` response never ends, so buffering it (e.g. via
    // `arrayBuffer()`) would never resolve — no bytes would ever reach the
    // client and the per-request server would stay pinned indefinitely.
    // Streaming also preserves mid-call progress delivery for normal calls.
    const body = Readable.fromWeb(response.body as any);

    // If the client disconnects mid-stream, cancel the read side so the
    // underlying MCP transport (and whatever it holds open) isn't left
    // dangling for a peer that is no longer there.
    res.once('close', () => {
      if (!body.destroyed) body.destroy();
    });
    body.once('error', () => {
      if (!res.writableEnded) res.destroy();
    });

    body.pipe(res);
  }

  /** RFC 6750 §3.1: no credential at all — a bare challenge, no `error`. */
  private missingCredential(res: Response): void {
    res.setHeader('WWW-Authenticate', 'Bearer realm="jeeta-mcp"');
    res.status(401).json({ error: 'unauthorized', error_description: 'missing bearer token' });
  }

  /** RFC 6750 §3.1: a credential WAS supplied, and it is invalid or revoked. */
  private invalidToken(res: Response, description: string): void {
    res.setHeader('WWW-Authenticate', `Bearer realm="jeeta-mcp", error="invalid_token", error_description="${description}"`);
    res.status(401).json({ error: 'invalid_token', error_description: description });
  }

  private toFetchRequest(req: Request): Request_ {
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return new Request(url, {
      method: req.method,
      headers: new Headers(req.headers as Record<string, string>),
    });
  }
}

type Request_ = globalThis.Request;
