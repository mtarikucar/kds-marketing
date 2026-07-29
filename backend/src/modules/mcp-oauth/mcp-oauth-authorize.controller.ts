import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { MarketingGuard } from '../marketing/guards/marketing.guard';
import { CurrentMarketingUser } from '../marketing/decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../marketing/types';
import { MCP_OAUTH_CONSENT_PAGE_PATH, mcpOAuthIssuer } from './mcp-oauth.config';
import { ConsentData, McpOAuthCodeService } from './mcp-oauth-code.service';
import { OAuthHttpException } from './mcp-oauth.errors';

/**
 * `/api/mcp-oauth/authorize` — the OAuth 2.1 authorization endpoint.
 *
 * Three routes, and the split matters:
 *
 *  - `GET /authorize` is where the CLIENT sends the browser. It is public
 *    (there is no credential yet) and it does exactly two things: validate the
 *    request, then hand the browser to the consent SPA route. It CANNOT mint a
 *    code — a GET that did would hand one out to anything able to cause a
 *    navigation, with no human ever agreeing.
 *  - `GET /authorize/consent` is the signed-in consent screen fetching what it
 *    needs to render (client name, requested scopes, the caller's workspaces).
 *  - `POST /authorize/consent` is the human saying yes. This one mints.
 *
 * The signed-in pair sits behind `MarketingGuard`, the same JWT guard the rest
 * of the marketing API uses, so the identity bound into the code is a real
 * logged-in user — resolved from the token, never from the request body.
 *
 * Every route re-validates the full request from its own parameters. Nothing is
 * carried over from a previous step: there is no server-side "pending
 * authorization" a caller could point at while substituting a different
 * redirect_uri or resource.
 *
 * Requests are read as loose objects rather than DTO classes on purpose. The
 * global ValidationPipe runs with `forbidNonWhitelisted`, which would 400 any
 * OAuth parameter we did not enumerate — while RFC 6749 §3.1 requires unknown
 * parameters to be IGNORED. Validation happens in the service instead, where an
 * OAuth error envelope can be produced.
 */
@Controller('mcp-oauth/authorize')
export class McpOAuthAuthorizeController {
  constructor(
    private readonly codes: McpOAuthCodeService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async authorize(
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    // Throwing here (rather than redirecting the error back) is deliberate:
    // until validate() has matched `redirect_uri` against the CIMD document,
    // that URI is attacker-supplied and redirecting to it is an open redirect.
    await this.codes.validate(query);

    const target = new URL(
      `${mcpOAuthIssuer(this.config.get<string>('PUBLIC_BASE_URL'))}${MCP_OAUTH_CONSENT_PAGE_PATH}`,
    );
    // Forward the request verbatim so the consent page can re-present it (and
    // the POST can re-validate it) without us holding server-side state.
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === 'string') target.searchParams.set(key, value);
    }
    res.redirect(target.toString());
  }

  @Get('consent')
  @UseGuards(MarketingGuard)
  async consentData(
    @Query() query: Record<string, unknown>,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ): Promise<ConsentData> {
    const req = await this.codes.validate(query);
    return this.codes.consentData(req, user.id);
  }

  @Post('consent')
  @UseGuards(MarketingGuard)
  async consent(
    @Body() body: Record<string, unknown>,
    @CurrentMarketingUser() user: MarketingUserPayload,
  ): Promise<{ redirect_to: string }> {
    const req = await this.codes.validate(body);

    const workspaceId = body.workspace_id;
    if (typeof workspaceId !== 'string' || !workspaceId) {
      throw new OAuthHttpException('invalid_request', 'workspace_id is required');
    }
    const granted = body.granted_scopes;
    if (!Array.isArray(granted) || granted.some((s) => typeof s !== 'string')) {
      throw new OAuthHttpException('invalid_request', 'granted_scopes must be an array of strings');
    }

    const { redirectTo } = await this.codes.grant(req, user.id, {
      workspaceId,
      scopes: granted as string[],
    });
    // The redirect is returned as data, not as a 302: the consent screen is a
    // SPA doing an XHR, and it navigates itself once it has the URL.
    return { redirect_to: redirectTo };
  }
}
