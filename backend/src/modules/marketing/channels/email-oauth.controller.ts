import { Controller, Get, Post, Body, Query, Res, UseGuards } from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import type { Response } from 'express';
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
  start(@Body() dto: StartEmailOAuthDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.start(u.workspaceId, dto.provider);
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
    @Res() res: Response,
  ) {
    const appUrl = (process.env.FRONTEND_URL ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
    if (error || !code || !state) {
      return res.redirect(302, `${appUrl}/accounts?connect_error=1`);
    }
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
