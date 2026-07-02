import {
  Body,
  Controller,
  Get,
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
import { verifyState } from './social-oauth-state.util';

class StartDto {
  /** Which page launched the connect ('social' Planner vs 'channels' inbox), so
   *  the public callback lands the user back there. Optional; default 'social'
   *  keeps existing links unchanged. */
  @IsOptional()
  @IsIn(['social', 'channels', 'account-center'])
  origin?: 'social' | 'channels' | 'account-center';
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
    // The marketing console (where /social lives) is FRONTEND_URL
    // (https://jeetagrowth.com) — NOT APP_URL, which is the core product.
    const appUrl = (process.env.FRONTEND_URL ?? process.env.APP_URL ?? '').replace(/\/+$/, '');
    // Land the user back where they launched from — the origin is inside the
    // signed state; peek it (best-effort) so even the error redirects go to the
    // right page. handleCallback still runs its own authoritative verify below.
    const origin = state ? verifyState(state)?.origin : undefined;
    const path =
      origin === 'channels' ? 'channels' : origin === 'account-center' ? 'accounts' : 'social';
    if (error || !code || !state) {
      return res.redirect(302, `${appUrl}/${path}?connect_error=1`);
    }
    try {
      const { pendingId } = await this.svc.handleCallback(network.toUpperCase(), code, state);
      return res.redirect(302, `${appUrl}/${path}?connect=${pendingId}`);
    } catch {
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
