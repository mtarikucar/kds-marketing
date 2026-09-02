import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsString, ArrayMaxSize, IsOptional, IsIn } from 'class-validator';
import type { Response } from 'express';
import { MarketingGuard } from '../../guards/marketing.guard';
import { MarketingRolesGuard } from '../../guards/marketing-roles.guard';
import { MarketingRoles } from '../../decorators/marketing-roles.decorator';
import { MarketingRoute, MarketingPublic } from '../../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../../types';
import { SocialOAuthService } from './social-oauth.service';
import { isOAuthNetwork } from './social-oauth.config';
import { verifyState } from './social-oauth-state.util';

/**
 * Console routes that READ the `?connect=<pendingId>` / `?connect_error=1`
 * params this callback appends. Landing anywhere else discards the result of a
 * consent the user has already given: the account picker never opens, the
 * pending row expires 15 minutes later, and nothing says why.
 *
 * `/accounts` (AccountCenterPage) is the only such route. `/social` is a
 * <Navigate> to a FIXED studio URL — the query is dropped on the way — and
 * `/channels` is not a route at all. Add an entry here only together with the
 * page-side reader.
 */
export const CONNECT_RESULT_ROUTES = ['accounts'] as const;
type ConnectResultRoute = (typeof CONNECT_RESULT_ROUTES)[number];

/** The page a connect can be launched from — travels inside the signed state. */
type StartOrigin = 'social' | 'channels' | 'account-center';

/**
 * Where each launch origin comes back to. Every origin resolves to the Account
 * Center today because it is the only surface that can show the result — the
 * origin is kept (it is inside the signed state, and the picker uses it to
 * decide what to pre-select) rather than deleted, but it can no longer name a
 * page that would silently swallow the connection.
 */
const ORIGIN_LANDING: Record<StartOrigin, ConnectResultRoute> = {
  social: 'accounts',
  channels: 'accounts',
  'account-center': 'accounts',
};

class StartDto {
  /** Which page launched the connect. Optional — it no longer decides WHETHER
   *  the result survives (every origin lands on a route that reads it), only
   *  what the picker pre-selects. */
  @IsOptional()
  @IsIn(['social', 'channels', 'account-center'])
  origin?: StartOrigin;
}

class ConfirmDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  selected: string[];

  /** externalIds of selected Pages/IG accounts that should ALSO be provisioned
   *  as a messaging Channel (opt-in; default off to avoid surprise inbox use). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  provisionMessaging?: string[];
}

/**
 * OAuth connect endpoints for the social planner. `start`/`pending`/`confirm`
 * are authenticated (MANAGER); `callback` is public because the provider
 * redirects the browser to it with no Authorization header — it does nothing
 * without a valid signed `state`. Never logs code/token/state.
 */
@MarketingRoute()
@Controller('marketing/social/oauth')
export class SocialOAuthController {
  private readonly logger = new Logger(SocialOAuthController.name);

  constructor(private readonly svc: SocialOAuthService) {}

  @Post(':network/start')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  start(
    @Param('network') network: string,
    @Body() dto: StartDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.start(u.workspaceId, network.toUpperCase(), dto?.origin);
  }

  @Get(':network/callback')
  @MarketingPublic()
  async callback(
    @Param('network') network: string,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    // A network we do not implement is a 404 about the URL — NOT a 302 telling
    // the user their connection failed. `/oauth/zzz/callback` used to be
    // indistinguishable from a real provider rejecting a real consent.
    if (!isOAuthNetwork(network.toUpperCase())) {
      throw new NotFoundException(`Unknown OAuth network: ${network}`);
    }
    // The marketing console (where /accounts lives) is FRONTEND_URL
    // (https://jeetagrowth.com) — NOT APP_URL, which is the core product.
    const appUrl = (process.env.FRONTEND_URL ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
    // Land the user back where they launched from — the origin is inside the
    // signed state; peek it (best-effort) so even the error redirects go to the
    // right page. handleCallback still runs its own authoritative verify below.
    const origin = state ? verifyState(state)?.origin : undefined;
    // Absent, or a value this build does not know (a state signed by another
    // deploy), falls back to the same param-reading route rather than to a
    // page that would drop the result.
    const path: ConnectResultRoute = ORIGIN_LANDING[origin as StartOrigin] ?? 'accounts';
    if (error || !code || !state) {
      return res.redirect(302, `${appUrl}/${path}?connect_error=1`);
    }
    try {
      const { pendingId } = await this.svc.handleCallback(network.toUpperCase(), code, state);
      return res.redirect(302, `${appUrl}/${path}?connect=${pendingId}`);
    } catch (e: any) {
      // The user gets an opaque `connect_error` — this URL is visible to
      // anyone over their shoulder, and the provider's message is unbounded
      // text we did not write. But the reason has to survive SOMEWHERE: the
      // two likeliest ways a consented connect dies (the app lacks an
      // App-Review permission; the provider has not allowlisted the project)
      // are invisible from the outside, and this catch used to swallow them
      // whole. Message only, never the code or the state.
      this.logger.warn(
        `OAuth callback failed for ${network.toUpperCase()}: ${e?.message ?? e}`,
      );
      return res.redirect(302, `${appUrl}/${path}?connect_error=1`);
    }
  }

  @Get('pending/:id')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  pending(@Param('id') id: string, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.listPending(u.workspaceId, id);
  }

  @Post('pending/:id/confirm')
  @UseGuards(MarketingGuard, MarketingRolesGuard)
  @MarketingRoles('MANAGER')
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmDto,
    @CurrentMarketingUser() u: MarketingUserPayload,
  ) {
    return this.svc.confirm(u.workspaceId, id, dto.selected, dto.provisionMessaging);
  }
}
