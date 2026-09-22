import { Controller, Get, Post, Body, Query, Req, Res, UseGuards } from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { readCookie } from '../controllers/public-referral.controller';
import { MarketingRoute, MarketingPublic } from '../decorators/marketing-public.decorator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { RequirePermission } from '../roles/require-permission.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { EMAIL_OAUTH_PROVIDERS } from './email-oauth.config';
import { EmailOAuthService } from './email-oauth.service';

class SuggestSmtpDto {
  /** In the BODY, never the query string: an address is personal data and a
   *  query string is written to every access log on the way. */
  @IsString()
  address: string;
}

class StartEmailOAuthDto {
  @IsString()
  @IsIn([...EMAIL_OAUTH_PROVIDERS])
  provider: string;
}

/**
 * Binds one consent round-trip to one browser.
 *
 * The signed `state` proves the authorize URL was minted here. It does NOT
 * prove it was minted for the person now consenting, and that is a real attack
 * rather than a theoretical one: workspace X starts a connect, forwards the
 * link to a target, and the target's consent — their mailbox, their tokens —
 * lands on X's channel, which can then read replies and send as them. The
 * cookie is what the attacker cannot plant in the victim's browser.
 *
 * It holds a HASH of the state, not the state: the cookie stays small, and the
 * signed, workspace-bearing token is not written to a second place.
 */
export const EMAIL_OAUTH_BIND_COOKIE = 'email_oauth_bind';

/** Scoped to this flow's own routes, so it is not sent with every request. */
const BIND_COOKIE_PATH = '/api/marketing/channels/email/oauth';

/** The state's own TTL is 10 minutes (social-oauth-state.util); matching it
 *  keeps "expired" one answer instead of two. */
const BIND_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

function bindValue(state: string): string {
  return createHash('sha256').update(state).digest('base64url');
}

/** Constant-time, and length-checked first because timingSafeEqual throws on a
 *  length mismatch — which an attacker controls. */
function bindMatches(state: string, cookie: string | undefined): boolean {
  if (!cookie) return false;
  const expected = Buffer.from(bindValue(state));
  const got = Buffer.from(cookie);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/**
 * Mailbox connect-by-consent.
 * - GET  providers → which buttons to show (empty = custom SMTP only)
 * - POST start     → the provider's consent URL
 * - GET  callback  → public; the provider redirects here → /accounts
 */
@MarketingRoute()
@Controller('marketing/channels/email/oauth')
@UseGuards(MarketingGuard, MarketingRolesGuard, PermissionsGuard)
export class EmailOAuthController {
  constructor(private readonly svc: EmailOAuthService) {}

  @Get('providers')
  @RequirePermission('settings.manage')
  providers() {
    return { providers: this.svc.providers() };
  }

  @Post('start')
  @MarketingRoles('MANAGER')
  @RequirePermission('settings.manage')
  start(
    @Body() dto: StartEmailOAuthDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { authorizeUrl, state } = this.svc.start(u.workspaceId, dto.provider);
    res.cookie(EMAIL_OAUTH_BIND_COOKIE, bindValue(state), {
      httpOnly: true,
      // Lax, NEVER Strict: the callback is a cross-site top-level GET from the
      // provider, and Strict would drop this cookie on every honest connect.
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: BIND_COOKIE_PATH,
      maxAge: BIND_COOKIE_MAX_AGE_MS,
    });
    // The state stays out of the response body: the SPA has no use for it, and
    // a value it can read is a value it can forward.
    return { authorizeUrl };
  }

  @Post('smtp-suggest')
  @RequirePermission('settings.manage')
  suggest(@Body() dto: SuggestSmtpDto) {
    return this.svc.suggestSmtpFor(dto.address).then((smtp) => ({ smtp }));
  }

  @Get('callback')
  @MarketingPublic()
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const appUrl = (process.env.FRONTEND_URL ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
    if (error || !code || !state) {
      return res.redirect(302, `${appUrl}/accounts?connect_error=1`);
    }
    // The browser that started this connect, or nobody. A forwarded authorize
    // URL arrives here without the cookie; a second use of the same link
    // arrives after the clear below has taken it away. One error page for both,
    // deliberately: it is the same answer to the owner, and a distinct message
    // would tell whoever forwarded the link how far they got.
    if (!bindMatches(state, readCookie(req, EMAIL_OAUTH_BIND_COOKIE))) {
      return res.redirect(302, `${appUrl}/accounts?connect_error=1`);
    }
    // Spent on arrival, before the exchange: a state is good for one callback
    // whatever the exchange then does with it.
    res.clearCookie(EMAIL_OAUTH_BIND_COOKIE, { path: BIND_COOKIE_PATH });
    try {
      await this.svc.handleCallback(code, state);
      // The address is NOT put on this URL. It is personal data, it would be
      // logged by every proxy on the way, and the page can read which mailbox
      // connected from the channel list it already loads.
      return res.redirect(302, `${appUrl}/accounts?email_connected=1`);
    } catch (e) {
      return res.redirect(302, `${appUrl}/accounts?connect_error=1`);
    }
  }
}
