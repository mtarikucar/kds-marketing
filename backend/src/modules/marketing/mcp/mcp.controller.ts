import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
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
export class McpController {
  private readonly handler: McpHttpHandler;

  constructor(
    private readonly factory: McpServerFactoryService,
    private readonly verifier: McpTokenVerifierService,
  ) {
    this.handler = createMcpHandler((ctx) => this.factory.build(ctx));
  }

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const authz = req.headers?.authorization;
    const token = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice(7).trim() : null;

    if (!token) {
      this.challenge(res, 'missing bearer token');
      return;
    }

    let authInfo;
    try {
      authInfo = await this.verifier.verifyAccessToken(token);
    } catch {
      this.challenge(res, 'invalid or revoked token');
      return;
    }

    const response = await this.handler.fetch(this.toFetchRequest(req), { authInfo });
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  private challenge(res: Response, description: string): void {
    res.setHeader('WWW-Authenticate', `Bearer error="invalid_token", error_description="${description}"`);
    res.status(401).json({ error: 'invalid_token', error_description: description });
  }

  private toFetchRequest(req: Request): Request_ {
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return new Request(url, {
      method: req.method,
      headers: new Headers(req.headers as Record<string, string>),
      body: JSON.stringify(req.body),
    });
  }
}

type Request_ = globalThis.Request;
