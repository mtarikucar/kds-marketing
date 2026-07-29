import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { McpOAuthTokenService, OAuthTokenResponse } from './mcp-oauth-token.service';

/**
 * `POST /api/mcp-oauth/token` — RFC 6749 §3.2.
 *
 * Public: CIMD clients are public clients and hold no secret, which is exactly
 * why PKCE is mandatory on the authorize side (the `code_verifier` is what
 * authenticates the exchange here, in place of a client secret).
 *
 * The body is read as a loose object rather than a DTO class. Clients post
 * `application/x-www-form-urlencoded` (parsed globally in app.config.ts) and
 * RFC 6749 §3.1 requires unrecognised parameters to be IGNORED — while the
 * global ValidationPipe runs `forbidNonWhitelisted` and would 400 anything we
 * had not enumerated. Validation lives in the service, where a rejection can be
 * rendered as an OAuth error envelope instead of Nest's default body.
 */
@Controller('mcp-oauth')
export class McpOAuthTokenController {
  constructor(private readonly tokens: McpOAuthTokenService) {}

  @Post('token')
  // RFC 6749 §5.1 mandates 200 for a successful token response; Nest would
  // otherwise answer a POST with 201.
  @HttpCode(200)
  async token(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OAuthTokenResponse> {
    // The response body carries bearer credentials — a shared cache holding it
    // would hand them to the next caller (RFC 6749 §5.1).
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return this.tokens.grant(body);
  }
}
